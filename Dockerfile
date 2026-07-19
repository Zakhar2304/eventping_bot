FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OAUTH_HOST=0.0.0.0 \
    DB_BACKEND=supabase

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot ./bot
COPY supabase ./supabase

EXPOSE 8080

CMD ["python", "-m", "bot"]
