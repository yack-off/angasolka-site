// Isolated, ephemeral database for the documented browser smoke test.
import {connectDatabase,migrate} from '../src/db.js';
import {buildApp} from '../src/app.js';
const db=await connectDatabase(undefined,'memory://');await migrate(db);
const app=await buildApp(db,{origin:'http://127.0.0.1:4181',localSetup:true,rateMax:10000});
await app.listen({host:'127.0.0.1',port:4181});
console.log('Isolated browser test: http://127.0.0.1:4181/admin/');
const close=async()=>{await app.close();await db.close();};
process.once('SIGINT',close);process.once('SIGTERM',close);
