FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TT_DB=/data/tracker.db \
    TT_PORT=8088

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8088/healthz')"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${TT_PORT}"]
