import type {Db} from './db.js';
export type Migration={version:number;name:string;statements:string[]};
export async function runMigrations(db:Db,owner:'web'|'runtime',migrations:Migration[]){
  await db.run('CREATE TABLE IF NOT EXISTS schema_migrations (owner TEXT NOT NULL,version INTEGER NOT NULL,name TEXT NOT NULL,applied_at INTEGER NOT NULL,PRIMARY KEY(owner,version))');
  const applied=new Map((await db.all('SELECT version,name FROM schema_migrations WHERE owner=?1',[owner])).map(row=>[Number(row.version),String(row.name)]));
  for(const migration of [...migrations].sort((a,b)=>a.version-b.version)){
    const existing=applied.get(migration.version);if(existing){if(existing!==migration.name)throw new Error(`migration ${owner}:${migration.version} name mismatch`);continue;}
    db.transactionRun([...migration.statements.map(sql=>({sql})),{sql:'INSERT INTO schema_migrations(owner,version,name,applied_at) VALUES (?1,?2,?3,?4)',params:[owner,migration.version,migration.name,Date.now()]}]);
  }
}
export async function tableHasColumn(db:Db,table:string,column:string){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))throw new Error('invalid table');return(await db.all(`PRAGMA table_info(${table})`)).some(row=>row.name===column);}
