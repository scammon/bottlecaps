"""
Tiny internal HTTP service wrapping huckleberry-api (py-huckleberry-api),
which requires Python >=3.14 -- kept as its own container/image rather than
bolted onto the Node app image, which stays on node:22-alpine.

Not exposed to the host; only bottlecaps-app talks to it, over the compose
network, by service name (matching how mongo is set up).
"""

import logging
import os
from datetime import datetime, timedelta, timezone

import aiohttp
from aiohttp import web
from google.cloud import firestore
from huckleberry_api import HuckleberryAPI

BOTTLECAPS_NOTE = "Bottlecaps"

logging.basicConfig(level=logging.INFO)
_LOGGER = logging.getLogger("huckleberry-service")

OZ_PER_ML = 1 / 29.5735

EMAIL = os.environ["HUCKLEBERRY_EMAIL"]
PASSWORD = os.environ["HUCKLEBERRY_PASSWORD"]
TIMEZONE = os.environ.get("HUCKLEBERRY_TIMEZONE", "America/New_York")
BOTTLE_TYPE = os.environ.get("HUCKLEBERRY_BOTTLE_TYPE", "Formula")
CHILD_UID_OVERRIDE = os.environ.get("HUCKLEBERRY_CHILD_UID") or None


async def _authenticated_api(session: aiohttp.ClientSession) -> HuckleberryAPI:
    api = HuckleberryAPI(
        email=EMAIL,
        password=PASSWORD,
        timezone=TIMEZONE,
        websession=session,
    )
    await api.authenticate()
    return api


async def _resolve_child_uid(api: HuckleberryAPI) -> str:
    if CHILD_UID_OVERRIDE:
        return CHILD_UID_OVERRIDE
    user = await api.get_user()
    if user is None:
        raise RuntimeError("could not fetch Huckleberry user document")
    if user.lastChild:
        return user.lastChild
    if user.childList:
        return user.childList[0].cid
    raise RuntimeError("Huckleberry account has no children on file")


async def handle_healthz(request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def handle_whoami(request: web.Request) -> web.Response:
    """Diagnostic: confirms credentials work and lists known children."""
    async with aiohttp.ClientSession() as session:
        try:
            api = await _authenticated_api(session)
            user = await api.get_user()
        except Exception as err:  # noqa: BLE001 -- surfaced to the caller, not swallowed
            _LOGGER.exception("whoami failed")
            return web.json_response({"ok": False, "error": str(err)}, status=502)

    if user is None:
        return web.json_response({"ok": False, "error": "no user document"}, status=502)

    return web.json_response(
        {
            "ok": True,
            "email": user.email,
            "lastChild": user.lastChild,
            "children": [
                {"cid": c.cid, "nickname": c.nickname} for c in (user.childList or [])
            ],
        }
    )


async def _find_bottle_interval_ref(api: HuckleberryAPI, child_uid: str, start_timestamp: float):
    """
    Locates the feed/{child_uid}/intervals doc for a bottle by the exact
    (child_uid, start, mode="bottle") it was created with -- log_bottle()
    itself uses this triple as an effectively natural key for a single call,
    since a given child only ever has one bottle interval starting at any
    particular instant. Used both to attach the "Bottlecaps" note right
    after creating an entry, and to push an amount correction to an entry
    that already exists.
    """
    client = await api._get_firestore_client()  # noqa: SLF001 -- no public accessor for this
    intervals_ref = client.collection("feed").document(child_uid).collection("intervals")
    query = (
        intervals_ref
        .where(filter=firestore.FieldFilter("start", "==", start_timestamp))
        .where(filter=firestore.FieldFilter("mode", "==", "bottle"))
        .limit(1)
    )
    docs = [doc async for doc in query.stream()]
    return docs[0].reference if docs else None


async def _tag_note(api: HuckleberryAPI, child_uid: str, start_timestamp: float, note: str) -> None:
    """
    Attaches a note to the interval doc just created by log_bottle(). That
    convenience method doesn't take a notes param (unlike log_solids, which
    does -- the underlying Firestore schema supports notes on every feed
    mode, log_bottle just doesn't expose it) -- so this finds the doc it
    wrote and merges the note into it as a small separate write, rather than
    reimplementing log_bottle()'s own logic (prefs.lastBottle update etc.)
    just to add one field.
    """
    ref = await _find_bottle_interval_ref(api, child_uid, start_timestamp)
    if ref is None:
        raise RuntimeError("could not find the just-created interval to attach a note to")
    await ref.set({"notes": note}, merge=True)


async def _update_bottle_amount(
    api: HuckleberryAPI, child_uid: str, start_timestamp: float, amount_oz: float
) -> None:
    """
    Corrects the amount on an *existing* bottle interval (bottlecaps editing
    an already-logged entry). Deliberately does not touch prefs.lastBottle --
    that field means "the most recent bottle, for quick-repeat in the
    Huckleberry app's own UI", and correcting some earlier entry's amount
    after the fact shouldn't change what a *different*, newer bottle's
    quick-repeat value is.
    """
    ref = await _find_bottle_interval_ref(api, child_uid, start_timestamp)
    if ref is None:
        raise RuntimeError("could not find the interval to update")
    await ref.set({"amount": amount_oz, "lastUpdated": datetime.now(timezone.utc).timestamp()}, merge=True)


async def handle_log_bottle(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        start_time = datetime.fromisoformat(body["start_time_iso"])
        amount_oz = float(body["amount_oz"])
    except (KeyError, ValueError, TypeError) as err:
        return web.json_response({"ok": False, "error": f"bad request: {err}"}, status=400)

    async with aiohttp.ClientSession() as session:
        try:
            api = await _authenticated_api(session)
            child_uid = await _resolve_child_uid(api)
            await api.log_bottle(
                child_uid,
                start_time=start_time,
                amount=amount_oz,
                bottle_type=BOTTLE_TYPE,
                units="oz",
            )
        except Exception as err:  # noqa: BLE001 -- surfaced to the caller, not swallowed
            _LOGGER.exception("log_bottle failed")
            return web.json_response({"ok": False, "error": str(err)}, status=502)

        # Best-effort: the bottle itself is already logged successfully at
        # this point, so a failure here shouldn't be reported as the overall
        # request failing.
        try:
            await _tag_note(api, child_uid, start_time.timestamp(), BOTTLECAPS_NOTE)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("logged the bottle but failed to attach the '%s' note", BOTTLECAPS_NOTE)

    _LOGGER.info("logged %s oz bottle at %s for child %s", amount_oz, start_time, child_uid)
    return web.json_response({"ok": True, "child_uid": child_uid})


async def handle_update_bottle(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        start_time = datetime.fromisoformat(body["start_time_iso"])
        amount_oz = float(body["amount_oz"])
    except (KeyError, ValueError, TypeError) as err:
        return web.json_response({"ok": False, "error": f"bad request: {err}"}, status=400)

    async with aiohttp.ClientSession() as session:
        try:
            api = await _authenticated_api(session)
            child_uid = await _resolve_child_uid(api)
            await _update_bottle_amount(api, child_uid, start_time.timestamp(), amount_oz)
        except Exception as err:  # noqa: BLE001 -- surfaced to the caller, not swallowed
            _LOGGER.exception("update_bottle failed")
            return web.json_response({"ok": False, "error": str(err)}, status=502)

    _LOGGER.info("updated bottle at %s to %s oz for child %s", start_time, amount_oz, child_uid)
    return web.json_response({"ok": True})


async def handle_list_bottles(request: web.Request) -> web.Response:
    """
    Real bottle-feed entries from Huckleberry itself, for reconciling
    against bottlecaps' own `bottles` collection (the "pull" side of the
    bidirectional sync -- entries logged straight in the Huckleberry app,
    bypassing bottlecaps entirely, still need to show up here).

    Returns only the most recent `limit` entries (default 10) -- NOT
    everything in the query window. `days` just has to be wide enough that a
    plausible feeding schedule yields at least `limit` results within it; it
    is deliberately not the thing that bounds what gets returned, since
    "the last ten bottles" (what this exists for) and "everything from the
    last N days" are two different, easily-confused things.
    """
    limit = int(request.query.get("limit", "10"))
    days = int(request.query.get("days", "30"))
    end_time = datetime.now(timezone.utc)
    start_time = end_time - timedelta(days=days)

    async with aiohttp.ClientSession() as session:
        try:
            api = await _authenticated_api(session)
            child_uid = await _resolve_child_uid(api)
            intervals = await api.list_feed_intervals(child_uid, start_time, end_time)
        except Exception as err:  # noqa: BLE001 -- surfaced to the caller, not swallowed
            _LOGGER.exception("list_bottles failed")
            return web.json_response({"ok": False, "error": str(err)}, status=502)

    bottles = []
    for interval in intervals:
        if getattr(interval, "mode", None) != "bottle" or interval.amount is None:
            continue
        amount_oz = interval.amount if interval.units == "oz" else interval.amount * OZ_PER_ML
        bottles.append(
            {
                "start_iso": datetime.fromtimestamp(interval.start, tz=timezone.utc).isoformat(),
                "amount_oz": round(amount_oz, 2),
            }
        )
    bottles.sort(key=lambda b: b["start_iso"])
    bottles = bottles[-limit:]
    return web.json_response({"ok": True, "bottles": bottles})


def make_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/healthz", handle_healthz)
    app.router.add_get("/whoami", handle_whoami)
    app.router.add_post("/log-bottle", handle_log_bottle)
    app.router.add_post("/update-bottle", handle_update_bottle)
    app.router.add_get("/list-bottles", handle_list_bottles)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=8080)
