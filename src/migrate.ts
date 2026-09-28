import {config} from './config.js';
import {connectDatabase,migrate} from './db.js';
const db=await connectDatabase(config.databaseUrl,config.dataDir);
try {await migrate(db);console.log('Database migrations applied.');} finally {await db.close();}
