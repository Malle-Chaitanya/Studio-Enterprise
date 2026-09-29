import { config } from '../config.js';
console.log('MS_CLIENT_ID set:', Boolean(config.MS_CLIENT_ID));
console.log('MS_CLIENT_SECRET set:', Boolean(config.MS_CLIENT_SECRET));
console.log('MONGO_HOST:', config.MONGO_HOST);
console.log('CSGE_DB:', config.CSGE_DB);
