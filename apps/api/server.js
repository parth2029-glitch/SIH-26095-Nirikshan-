import { connect } from './db.js';
import { createApp } from './app.js';
import { startMerkleJob } from './overrides.js';
import { warm } from './corpus.js';

const port = Number(process.env.PORT) || 4000;

await connect();
// Not inside createApp(): a test that builds an app must not spawn a timer.
startMerkleJob();
// Warmed here rather than on the first scored report, for the same reason the
// job is: a test builds an app against a database that may hold no evidence at
// all, and the corpus falls back to warming itself lazily when it does (§11).
console.log(`trust: dHash corpus warmed with ${await warm()} images`);
createApp().listen(port, () => console.log(`api: listening on http://localhost:${port}`));
