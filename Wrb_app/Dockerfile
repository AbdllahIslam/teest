FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app

# Install system dependencies needed for TF and building some packages
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       curl \
       ca-certificates \
       git \
       pkg-config \
       libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/

# Use wheels where possible and avoid cache to keep image small
RUN pip install --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r requirements.txt

# Copy app sources
COPY . /app/

ENV PORT=5000
EXPOSE 5000

# Run with gunicorn using the default sync worker
CMD ["sh", "-c", "gunicorn server:app --workers 1 --worker-class sync --threads 4 --timeout 300 --bind 0.0.0.0:${PORT}"]
