import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { readFile, mkdir } from 'node:fs/promises';

export interface Queryable { query<T extends Record<string, any> = Record<string, any>>(sql: string, params?: any[]): Promise<{rows:T[]}> }
export interface Database extends Queryable { transaction<T>(fn:(tx:Queryable)=>Promise<T>):Promise<T>; close():Promise<void> }

export async function connectDatabase(url?:string, directory='./data/postgres'):Promise<Database> {
  if (url) {
    const pool = new pg.Pool({connectionString:url, max:10, connectionTimeoutMillis:5000, statement_timeout:10000});
    return {
      query: (sql,params)=>pool.query(sql,params),
      async transaction(fn) {
        const client=await pool.connect();
        try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; }
        catch(error) { await client.query('ROLLBACK'); throw error; }
        finally {client.release();}
      },
      close:()=>pool.end()
    };
  }
  if(directory!=='memory://')await mkdir(directory,{recursive:true});
  const embedded=new PGlite(directory);
  await embedded.waitReady;
  return {
    query:(sql,params)=>embedded.query(sql,params),
    transaction:fn=>embedded.transaction(tx=>fn(tx)),
    close:()=>embedded.close()
  };
}

export async function migrate(db:Database) {
  // Transaction-scoped locking serializes migration runners on real PostgreSQL.
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(418001)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for(const [version,file] of [[1,'001_initial.sql'],[2,'002_admin.sql'],[3,'003_crm.sql'],[4,'004_telegram.sql']] as const) {
      const {rows}=await tx.query('SELECT version FROM schema_migrations WHERE version=$1',[version]);
      if(rows.length)continue;
      const sql=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');
      // Migration contains no stored procedures or embedded semicolons.
      for(const statement of sql.split(';').filter(s=>s.trim())) await tx.query(statement);
      if(version===2) {
        const blocks=JSON.parse(await readFile(new URL('../content-seed.json',import.meta.url),'utf8'));
        for(const b of blocks)await tx.query('INSERT INTO content_blocks(id,title,sort_order,fields) VALUES($1,$2,$3,$4)',[b.id,b.title,b.sort_order,JSON.stringify(b.fields)]);
      }
      await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]);
    }
  });
}
