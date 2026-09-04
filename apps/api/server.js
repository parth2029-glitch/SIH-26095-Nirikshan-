import { connect } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 4000;

await connect();
createApp().listen(port, () => console.log(`api: listening on http://localhost:${port}`));
