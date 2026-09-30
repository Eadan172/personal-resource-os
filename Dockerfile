FROM python:3.12-slim

WORKDIR /app
COPY core/ ./core/
COPY mcp_gateway/ ./mcp_gateway/
COPY tests/ ./tests/
COPY pyproject.toml ./

RUN pip install --no-cache-dir fastapi uvicorn pytest

ENV PYTHONPATH=/app/core:/app \
    PROS_DATA_DIR=/data \
    PROS_PROVIDER=mock

VOLUME ["/data"]
EXPOSE 8765

# 默认启动 API；离线模式可用 PROS_PROVIDER=mock / local
CMD ["python3", "-m", "personal_agent_core.cli", "serve"]
