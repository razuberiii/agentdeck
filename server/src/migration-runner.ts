import type {Db} from './db.js';
export type Migration={version:number;name:string;statements:string[];columns?:Record<string,Record<string,string>>};
export async function runMigrations(db:Db,owner:'web'|'runtime',migrations:Migration[]){
  await db.run('CREATE TABLE IF NOT EXISTS schema_migrations (owner TEXT NOT NULL,version INTEGER NOT NULL,name TEXT NOT NULL,applied_at INTEGER NOT NULL,PRIMARY KEY(owner,version))');
  const applied=new Map((await db.all('SELECT version,name FROM schema_migrations WHERE owner=?1',[owner])).map(row=>[Number(row.version),String(row.name)]));
  for(const migration of [...migrations].sort((a,b)=>a.version-b.version)){
    const existing=applied.get(migration.version);if(existing){if(existing!==migration.name)throw new Error(`migration ${owner}:${migration.version} name mismatch`);continue;}
    const columnStatements:string[]=[];
    for(const [table,columns] of Object.entries(migration.columns||{})){const existingColumns=new Set((await db.all(`PRAGMA table_info(${safeIdentifier(table)})`)).map(row=>String(row.name)));for(const [column,declaration]of Object.entries(columns))if(!existingColumns.has(column))columnStatements.push(`ALTER TABLE ${safeIdentifier(table)} ADD COLUMN ${safeIdentifier(column)} ${declaration}`);}
    const statements:Array<{sql:string;params?:unknown[]}>= [...columnStatements,...migration.statements].map(sql=>({sql}));
    statements.push({sql:'INSERT INTO schema_migrations(owner,version,name,applied_at) VALUES (?1,?2,?3,?4)',params:[owner,migration.version,migration.name,Date.now()]});
    db.transactionRun(statements);
  }
}
export async function tableHasColumn(db:Db,table:string,column:string){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))throw new Error('invalid table');return(await db.all(`PRAGMA table_info(${table})`)).some(row=>row.name===column);}
export type RequiredSchema={tables:Record<string,string[]>;indexes:string[]};
export async function assertSchema(db:Db,owner:string,required:RequiredSchema){const objects=await db.all("SELECT type,name FROM sqlite_master WHERE type IN ('table','index')"),tables=new Set(objects.filter(row=>row.type==='table').map(row=>String(row.name))),indexes=new Set(objects.filter(row=>row.type==='index').map(row=>String(row.name)));for(const[table,columns]of Object.entries(required.tables)){if(!tables.has(table))throw new Error(`${owner} schema incomplete: missing table ${table}`);const actual=new Set((await db.all(`PRAGMA table_info(${safeIdentifier(table)})`)).map(row=>String(row.name)));for(const column of columns)if(!actual.has(column))throw new Error(`${owner} schema incomplete: missing ${table}.${column}`);}for(const index of required.indexes)if(!indexes.has(index))throw new Error(`${owner} schema incomplete: missing index ${index}`);}
function safeIdentifier(value:string){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))throw new Error(`invalid SQL identifier: ${value}`);return value;}
