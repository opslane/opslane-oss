# Custom E2B template for the Python fix pipeline (Batch 3, opslane-oss#89).
# Python 3.12 + system deps from the design: build-essential (C extensions),
# libpq-dev (psycopg2), libffi-dev (cffi), git for repo clones.
# pytest is preinstalled because the Batch 3 test gate runs it against repos
# whose runtime requirements don't declare it.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev libffi-dev git curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir pytest==8.2.2
