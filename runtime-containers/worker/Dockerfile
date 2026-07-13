# Build from repo root: docker build -f runtime-containers/worker/Dockerfile .
FROM node:22-slim

# Install Python 3.11 and 3.12 for job execution parity (plan 6).
# python3-pip provides pip for sdk/python installation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3.11 python3.12 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies for the worker service.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Install the Python SDK and ML libraries used by Python jobs.
# numpy/scipy/pandas/scikit-learn cover array math, statistics, and ML algorithms.
# python-dateutil handles ISO 8601 timestamps from AIC API responses.
# PYTHONPATH is also set at runtime as a fallback for local dev.
COPY sdk/python /build/sdk
RUN pip install --no-cache-dir \
    numpy \
    scipy \
    pandas \
    scikit-learn \
    python-dateutil \
    /build/sdk

# Copy the scheduler service source that the worker depends on.
# The worker entry point is src/workers/app.js; it imports from src/services/
# and src/clients/ — copy the whole src tree rather than cherry-picking.
COPY src ./src

USER node
ENV NODE_ENV=production
CMD ["node", "src/workers/app.js"]
