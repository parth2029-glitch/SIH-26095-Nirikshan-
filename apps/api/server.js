import { connect } from './db.js';
import { createApp } from './app.js';
import { startMerkleJob } from './overrides.js';

const port = Number(process.env.PORT) || 4000;

await connect();
// Not inside createApp(): a test that builds an app must not spawn a timer.
startMerkleJob();
createApp().listen(port, () => console.log(`api: listening on http://localhost:${port}`));
