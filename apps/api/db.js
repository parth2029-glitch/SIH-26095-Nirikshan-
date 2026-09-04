import mongoose from 'mongoose';

/**
 * Connect to Mongo, retrying with linear backoff.
 *
 * Retry exists because `docker compose up` returns before Mongo is accepting
 * connections — the API restarts faster than the database does.
 */
export async function connect(uri = process.env.MONGODB_URI, { retries = 5, delayMs = 2000 } = {}) {
  if (!uri) throw new Error('MONGODB_URI is not set — copy .env.example to .env');

  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      return mongoose.connection;
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = delayMs * attempt;
      console.warn(
        `mongo: connect failed (${attempt}/${retries}), retrying in ${wait}ms — ${err.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export function disconnect() {
  return mongoose.disconnect();
}
