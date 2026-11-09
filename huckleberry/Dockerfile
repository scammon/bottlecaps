# huckleberry-api requires Python >=3.14. Kept as its own image, separate
# from the node:22-alpine app image.
FROM python:3.14-slim

# Apply the latest Debian security patches on every build.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 8080
CMD ["python", "app.py"]
