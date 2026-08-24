"""
Tiny internal HTTP service wrapping huckleberry-api (py-huckleberry-api),
which requires Python >=3.14 -- kept as its own container/image rather than
bolted onto the Node app image, which stays on node:22-alpine.

Not exposed to the host; only bottlecaps-app talks to it, over the compose
network, by service name (matching how mongo is set up).
"""

import logging
import os
from datetime import datetime

import aiohttp
from aiohttp import web
from huckleberry_api import HuckleberryAPI

logging.basicConfig(level=logging.INFO)
_LOGGER = logging.getLogger("huckleberry-service")

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

    _LOGGER.info("logged %s oz bottle at %s for child %s", amount_oz, start_time, child_uid)
    return web.json_response({"ok": True, "child_uid": child_uid})


def make_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/healthz", handle_healthz)
    app.router.add_get("/whoami", handle_whoami)
    app.router.add_post("/log-bottle", handle_log_bottle)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="0.0.0.0", port=8080)
