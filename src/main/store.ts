import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import type { BusinessConfig, Entity, Field, Line, Payment, RecordData, Shop, Snapshot, Value } from '../shared/types';

const now = () => new Date().toISOString();
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
function text(value: unknown, label: string, required = false): string {
  if (typeof value !== 'string' || value.length > 20000 || (required && !value.trim())) throw new Error(`${label} is required or invalid`);
  return value.trim();
}
function numeric(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || Math.abs(value) > 1e12) throw new Error(`${label} must be a valid number of at least ${min}`);
  return value;
}
function password(value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) throw new Error('Password must contain 8–200 characters');
  return value;
}
function method(value: unknown): string {
  if (typeof value !== 'string' || !['cash', 'card', 'bank'].includes(value.toLowerCase())) throw new Error('Choose cash, card or bank');
  return value.toLowerCase();
}
function cancelled(status: unknown): boolean { return typeof status === 'string' && /^cancelled$|^canceled$/i.test(status); }
function image(value: unknown): string {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 1500000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) throw new Error('Image must be a PNG, JPEG or WebP smaller than 1 MB');
  const [header, encoded] = value.split(',');
  const bytes = Buffer.from(encoded, 'base64');
  const valid = header.includes('/png') ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : header.includes('/jpeg') ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid || bytes.length > 1024 * 1024) throw new Error('Image data is invalid or too large');
  return value;
}
function validateDate(value: string, field: Field): string {
  if (!value && !field.required) return '';
  const validFormat = field.type === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
  if (!validFormat.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${field.label} must be a valid date`);
  const datePart = value.slice(0,10);
  if (new Date(`${datePart}T12:00:00Z`).toISOString().slice(0,10) !== datePart) throw new Error(`${field.label} must be a valid date`);
  return value;
}
function bounds(value: number, field: Field) {
  if(field.max!==undefined&&value>field.max)throw new Error(`${field.label} cannot exceed ${field.max}`);
  if(field.integer&&!Number.isInteger(value))throw new Error(`${field.label} must be a whole number`);
}

/** Business-specific records share infrastructure, never a database identity. */
export class Store {
  private db!: DatabaseSync;
  private user: { name: string; username: string } | null = null;
  constructor(private filePath: string, private config: BusinessConfig) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.connect();
  }
  private connect() {
    this.db = new DatabaseSync(this.filePath);
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
      if (version > 1) throw new Error('Database requires a newer version of this application');
      const hasMeta = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
      if (hasMeta) {
        const identity = this.db.prepare("SELECT value FROM meta WHERE key='appId'").get() as {value:string}|undefined;
        if (!identity || identity.value !== this.config.id) throw new Error('This database belongs to a different application');
      } else if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new Error('Unsupported database');
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS account(username TEXT PRIMARY KEY,name TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,entity TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS records_entity ON records(entity);
        CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,recordId TEXT NOT NULL REFERENCES records(id),entity TEXT NOT NULL,amount REAL NOT NULL,method TEXT NOT NULL,createdAt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,username TEXT,action TEXT NOT NULL,details TEXT NOT NULL,createdAt TEXT NOT NULL);
        PRAGMA user_version=1;`);
      this.db.prepare("INSERT OR IGNORE INTO meta VALUES('appId',?)").run(this.config.id);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private auth() { if (!this.user) throw new Error('Please sign in'); return this.user; }
  private definition(key: string): Entity {
    const entity = this.config.entities.find(entity => entity.key === key);
    if (!entity) throw new Error('Unknown record type');
    return entity;
  }
  private records(): RecordData[] {
    return (this.db.prepare('SELECT data FROM records ORDER BY rowid DESC').all() as {data:string}[]).map(row => JSON.parse(row.data));
  }
  private get(id: string, entity?: string): RecordData {
    const row = this.db.prepare('SELECT data FROM records WHERE id=?').get(id) as {data:string}|undefined;
    if (!row) throw new Error('Record not found');
    const record: RecordData = JSON.parse(row.data);
    if (entity && record.entity !== entity) throw new Error('Reference belongs to a different record type');
    return record;
  }
  private put(record: RecordData) {
    this.db.prepare('INSERT INTO records(id,entity,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,entity=excluded.entity').run(record.id,record.entity,JSON.stringify(record));
  }
  private audit(action: string, details = '') { this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(),this.user?.username || null,action,details,now()); }
  private shop(value: Shop): Shop {
    if (!value || typeof value !== 'object') throw new Error('Business details are required');
    return {name:text(value.name,'Business name',true),phone:text(value.phone,'Phone'),address:text(value.address,'Address'),currency:text(value.currency,'Currency',true).toUpperCase(),footer:text(value.footer,'Receipt footer')};
  }
  snapshot(): Snapshot {
    const shop = this.db.prepare("SELECT value FROM meta WHERE key='shop'").get() as {value:string}|undefined;
    return {configured:!!shop,shop:shop?JSON.parse(shop.value):null,user:this.user?{...this.user}:null,records:this.user?this.records():[],payments:this.user?this.db.prepare('SELECT * FROM payments ORDER BY createdAt DESC').all() as unknown as Payment[]:[],dataPath:this.filePath,version:'0.1.0'};
  }
  setup(input: {shop: Shop; name: string; username: string; password: string}): Snapshot {
    if (this.snapshot().configured || this.db.prepare('SELECT username FROM account LIMIT 1').get()) throw new Error('Business is already configured');
    const shop=this.shop(input.shop),name=text(input.name,'Your name',true),username=text(input.username,'Username',true).toLowerCase(),secret=password(input.password),salt=randomBytes(16).toString('hex');
    this.tx(()=> {
      this.db.prepare('INSERT INTO account VALUES(?,?,?,?)').run(username,name,salt,scryptSync(secret,salt,64).toString('hex'));
      this.db.prepare("INSERT INTO meta VALUES('shop',?)").run(JSON.stringify(shop));
      this.audit('setup');
    });
    return this.login(username,secret);
  }
  login(username: string, secret: string): Snapshot {
    const key=text(username,'Username',true).toLowerCase();
    const row=this.db.prepare('SELECT * FROM account WHERE username=?').get(key) as {username:string;name:string;salt:string;hash:string}|undefined;
    if(typeof secret!=='string'||secret.length>200) throw new Error('Incorrect username or password');
    const hash=scryptSync(secret,row?.salt || '00000000000000000000000000000000',64);
    if(!row || !timingSafeEqual(hash,Buffer.from(row.hash,'hex'))) throw new Error('Incorrect username or password');
    this.user={name:row.name,username:row.username};this.audit('login');return this.snapshot();
  }
  logout(): Snapshot {this.user=null;return this.snapshot();}
  saveShop(input: Shop): Snapshot {this.auth();const shop=this.shop(input);this.tx(()=> {this.db.prepare("UPDATE meta SET value=? WHERE key='shop'").run(JSON.stringify(shop));this.audit('shop-settings');});return this.snapshot();}
  changePassword(current: string, next: string): Snapshot {
    const user=this.auth(),secret=password(next);
    if(typeof current!=='string'||current.length>200)throw new Error('Current password is incorrect');
    const row=this.db.prepare('SELECT salt,hash FROM account WHERE username=?').get(user.username) as {salt:string;hash:string};
    if(!timingSafeEqual(scryptSync(current,row.salt,64),Buffer.from(row.hash,'hex')))throw new Error('Current password is incorrect');
    if(current===secret)throw new Error('Choose a different new password');
    const salt=randomBytes(16).toString('hex');
    this.tx(()=> {this.db.prepare('UPDATE account SET salt=?,hash=? WHERE username=?').run(salt,scryptSync(secret,salt,64).toString('hex'),user.username);this.audit('password-change');});return this.snapshot();
  }
  private values(entity: Entity, input: Record<string,Value>, previous?: RecordData): Record<string,Value> {
    if(!input || typeof input!=='object'||Array.isArray(input))throw new Error('Invalid record fields');
    const values:Record<string,Value>={};
    const targets=new Set(entity.calculations?.map(calculation=>calculation.target) || []);
    for(const field of entity.fields) {
      let value: unknown=input[field.key] ?? previous?.values[field.key] ?? field.default;
      if(entity.workflow?.field===field.key) value=previous?.values[field.key] ?? entity.workflow.initial;
      if(targets.has(field.key)) {values[field.key]=0;continue;}
      if(field.type==='checkbox') { if(value===undefined)value=false;if(typeof value!=='boolean')throw new Error(`${field.label} is invalid`);values[field.key]=value;continue; }
      if(field.type==='number'||field.type==='money') {
        if(value===undefined||value==='') {if(field.required)throw new Error(`${field.label} is required`);value=0;}
        const number=numeric(value,field.label,!field.required&&value===0?0:(field.min??0));bounds(number,field);values[field.key]=field.type==='money'?round(number):number;continue;
      }
      if(field.type==='lines') {
        if(value===undefined)value=[];
        if(!Array.isArray(value)||value.length>200||(field.required&&!value.length))throw new Error(`${field.label} needs at least one valid item`);
        values[field.key]=value.map((line:Line)=> {
          if(!line||typeof line!=='object')throw new Error('Invalid line item');
          const product=this.get(text(line.productId,'Item',true),field.reference);
          if(product.archived)throw new Error('Item is archived');
          const quantity=numeric(line.quantity,'Quantity',field.min??0.001);bounds(quantity,{...field,label:`${field.label} quantity`});if(quantity>1000000)throw new Error('Quantity is too large');
          const original=(previous?.values[field.key] as Line[]|undefined)?.find(item=>item.productId===product.id);
          const price=field.stockEffect===1 ? round(numeric(line.price,'Unit price')) : round(numeric(original?.price ?? product.values[field.priceField || 'price'],'Item price'));
          const definition=this.definition(product.entity);
          return {productId:product.id,quantity,price,name:String(product.values[definition.primary] || `#${product.number}`)};
        });continue;
      }
      if(field.type==='image') {values[field.key]=image(value ?? '');continue;}
      const string=text(value ?? '',field.label,!!field.required);
      if(field.type==='select' && string && !field.options?.includes(string))throw new Error(`Choose a valid ${field.label}`);
      if(field.type==='date'||field.type==='datetime-local')validateDate(string,field);
      if(field.type==='reference' && string) {const record=this.get(string,field.reference);if(record.archived)throw new Error(`${field.label} is archived`);}
      values[field.key]=string;
    }
    for(const calc of entity.calculations || []) {
      let value=0;
      if(calc.op==='sumLines') value=(values[calc.fields[0]] as Line[]).reduce((sum,line)=>sum+line.quantity*line.price,0);
      else if(calc.op==='multiply') value=calc.fields.reduce((result,key)=>result*Number(values[key] || 0),1);
      else if(calc.op==='percent') {
        const rate=numeric(Number(values[calc.fields[1]] || 0),'Percentage');
        if(rate>100)throw new Error('Percentage cannot exceed 100');
        value=Number(values[calc.fields[0]] || 0)*rate/100;
      }
      else value=calc.fields.reduce((sum,key)=>sum+Number(values[key] || 0),0);
      values[calc.target]=round(numeric(value,calc.target));
    }
    if(entity.finance) {
      const {total,paid}=entity.finance;
      const amount=round(numeric(values[total],'Total')),received=round(numeric(values[paid],'Paid'));
      if(received>amount)throw new Error('Paid amount cannot exceed total');
      if(previous && received!==previous.values[paid])throw new Error('Use Collect payment to change the paid amount');
      if(previous&&Number(previous.values[paid])>0)for(const key of ['paymentMethod','method'])if(values[key]!==previous.values[key])throw new Error('The original payment method cannot be changed after payment');
      values[total]=amount;values[paid]=received;
      const status=this.financeStatus(entity,values);if(status&&entity.workflow)values[entity.workflow.field]=status;
    }
    this.checkDates(entity,values);
    return values;
  }
  private checkDates(entity: Entity,values: Record<string,Value>) {
    for(const [start,end] of entity.dateOrder || []) {
      if(!values[start]||!values[end])continue;
      if(Date.parse(String(values[end]))<Date.parse(String(values[start])))throw new Error(`${entity.fields.find(field=>field.key===end)?.label || end} cannot be before ${entity.fields.find(field=>field.key===start)?.label || start}`);
    }
  }
  private financeStatus(entity: Entity,values: Record<string,Value>): string|null {
    if(!entity.finance||!entity.workflow||!['Due','Part-paid','Settled'].every(state=>entity.workflow!.states.includes(state)))return null;
    return Number(values[entity.finance.paid])>=Number(values[entity.finance.total])?'Settled':Number(values[entity.finance.paid])>0?'Part-paid':'Due';
  }
  private checkUnique(entity: Entity, record: RecordData) {
    for(const keys of entity.unique || []) {
      if(keys.some(key=>record.values[key]===''||record.values[key]===undefined))continue;
      if(this.records().some(other=>other.entity===entity.key&&other.id!==record.id&&!other.archived&&keys.every(key=>String(other.values[key]).toLowerCase()===String(record.values[key]).toLowerCase())))throw new Error(`A ${entity.singular.toLowerCase()} already exists with these ${keys.map(key=>entity.fields.find(f=>f.key===key)?.label || key).join(' / ')}`);
    }
  }
  private checkBookings(records=this.records()) {
    for(const entity of this.config.entities) {
      const rule=entity.booking;if(!rule)continue;
      const bookings=records.filter(record=>record.entity===entity.key&&!record.archived&&!rule.inactive.includes(String(record.values[entity.workflow?.field || 'status'])));
      const isDate=entity.fields.find(field=>field.key===rule.start)?.type==='date';
      for(const booking of bookings) {
        const start=Date.parse(String(booking.values[rule.start])),end=Date.parse(String(booking.values[rule.end]));
        if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||(!isDate&&end===start))throw new Error('Booking end must be after its start');
        const resource=records.find(record=>record.id===booking.values[rule.resource]);
        if(!resource)throw new Error('Booking resource not found');
        const capacity=rule.capacity?numeric(resource.values[rule.capacity],'Resource capacity',0):1;
        // Evaluate every boundary, rather than summing disjoint overlapping bookings.
        const points=[start,...bookings.filter(other=>other.values[rule.resource]===booking.values[rule.resource]).map(other=>Date.parse(String(other.values[rule.start]))).filter(point=>point>=start&&point<=end)];
        for(const point of points) {
          const used=bookings.filter(other=>other.values[rule.resource]===booking.values[rule.resource]&&Date.parse(String(other.values[rule.start]))<=point&&(isDate?Date.parse(String(other.values[rule.end]))>=point:Date.parse(String(other.values[rule.end]))>point)).reduce((sum,other)=>sum+(rule.quantity?numeric(other.values[rule.quantity],'Booking quantity',0.001):1),0);
          if(used>capacity)throw new Error('This time or date range exceeds the available capacity');
        }
      }
    }
  }
  private stockChanges(entity: Entity, oldRecord: RecordData|undefined, newRecord: RecordData|undefined) {
    const changes=new Map<string,{field:string;id:string;delta:number}>();
    for(const field of entity.fields.filter(field=>field.type==='lines'&&field.stockEffect&&field.stockField)) {
      for(const [record,direction] of [[oldRecord,-1],[newRecord,1]] as const) {
        if(!record)continue;
        for(const line of record.values[field.key] as Line[]) {
          const key=`${line.productId}:${field.stockField}`,old=changes.get(key);
          changes.set(key,{id:line.productId,field:field.stockField!,delta:(old?.delta || 0)+line.quantity*field.stockEffect!*direction});
        }
      }
    }
    for(const change of changes.values()) {
      const product=this.get(change.id),stock=numeric(product.values[change.field],'Stock');
      const quantity=Math.round((stock+change.delta)*1000000)/1000000;
      if(quantity<0)throw new Error(`Insufficient stock: ${product.values[this.definition(product.entity).primary]}`);
      this.put({...product,values:{...product.values,[change.field]:quantity},updatedAt:now()});
    }
  }
  save(entityKey: string,id: string|null,input: Record<string,Value>): Snapshot {
    this.auth();const entity=this.definition(entityKey);
    this.tx(()=> {
      const previous=id?this.get(id,entityKey):undefined;
      if(previous?.archived || previous && entity.workflow?.terminal.includes(String(previous.values[entity.workflow.field])))throw new Error('Completed or cancelled records cannot be edited');
      const values=this.values(entity,input,previous);
      const counter=`sequence:${entityKey}`;
      const last=Number((this.db.prepare('SELECT value FROM meta WHERE key=?').get(counter) as {value:string}|undefined)?.value || 0);
      const record:RecordData={id:previous?.id || randomUUID(),entity:entityKey,number:previous?.number || last+1,createdAt:previous?.createdAt || now(),updatedAt:now(),values,archived:false};
      this.checkUnique(entity,record);
      this.stockChanges(entity,previous,record);
      this.put(record);this.checkBookings();
      if(!previous) {
        this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(counter,String(record.number));
        if(entity.finance && Number(values[entity.finance.paid])>0)this.payment(record,Number(values[entity.finance.paid]),method(values.paymentMethod || values.method || 'cash'));
      }
      this.audit(previous?'edit-record':'create-record',`${entityKey}:${record.id}`);
    });return this.snapshot();
  }
  transition(entityKey: string,id: string,status: string): Snapshot {
    this.auth();const entity=this.definition(entityKey),workflow=entity.workflow;
    if(!workflow||!workflow.states.includes(status))throw new Error('Invalid workflow status');
    this.tx(()=> {
      const record=this.get(id,entityKey),current=String(record.values[workflow.field]);
      if(workflow.terminal.includes(current))throw new Error('Completed or cancelled records cannot be reopened');
      if(current===status)throw new Error('Record is already in this status');
      const financialStatus=this.financeStatus(entity,record.values);
      if(financialStatus&&['Due','Part-paid','Settled'].includes(status)&&status!==financialStatus)throw new Error('Payment status is calculated from the actual balance; collect payment instead');
      if(!cancelled(status)&&workflow.states.indexOf(status)<workflow.states.indexOf(current))throw new Error('Workflow cannot move backwards');
      if(cancelled(status)) {
        if(entity.finance&&Number(record.values[entity.finance.paid])>0)throw new Error('A paid record cannot be cancelled; refunds are not supported in this pilot');
        this.stockChanges(entity,record,undefined);
      }
      this.put({...record,updatedAt:now(),values:{...record.values,[workflow.field]:status}});
      this.checkBookings();this.audit('workflow',`${id}:${status}`);
    });return this.snapshot();
  }
  private payment(record: RecordData,amount: number,paymentMethod: string) {
    this.db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?)').run(randomUUID(),record.id,record.entity,amount,paymentMethod,now());
  }
  collect(id: string,amount: number,paymentMethod: string): Snapshot {
    this.auth();const value=round(numeric(amount,'Payment',0.01)),kind=method(paymentMethod);
    this.tx(()=> {
      const record=this.get(id),entity=this.definition(record.entity),finance=entity.finance;
      if(!finance || record.archived || cancelled(record.values[entity.workflow?.field || 'status']))throw new Error('Payment cannot be collected for this record');
      const due=round(Number(record.values[finance.total])-Number(record.values[finance.paid]));
      if(value>due || due<=0)throw new Error('Payment exceeds the outstanding balance');
      const values={...record.values,[finance.paid]:round(Number(record.values[finance.paid])+value)};
      const status=this.financeStatus(entity,values);if(status&&entity.workflow)values[entity.workflow.field]=status;
      this.put({...record,updatedAt:now(),values});
      this.payment(record,value,kind);this.audit('collect-payment',`${id}:${value}:${kind}`);
    });return this.snapshot();
  }
  backupTo(target: string) {
    if(resolve(target)===resolve(this.filePath))throw new Error('Choose a different backup location');
    this.db.exec("VACUUM INTO '"+target.replace(/'/g,"''")+"'");
  }
  private validateBackup(candidate: DatabaseSync) {
    const version=(candidate.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if(version!==1)throw new Error('Unsupported backup version');
    const identity=candidate.prepare("SELECT value FROM meta WHERE key='appId'").get() as {value:string}|undefined;
    if(identity?.value!==this.config.id)throw new Error('Backup belongs to a different application');
    const integrity=candidate.prepare('PRAGMA integrity_check').get() as Record<string,string>;
    if(Object.values(integrity)[0]!=='ok')throw new Error('Backup database is damaged');
    const shop=candidate.prepare("SELECT value FROM meta WHERE key='shop'").get() as {value:string}|undefined;
    if(!shop)throw new Error('Backup has no business');this.shop(JSON.parse(shop.value));
    const accounts=candidate.prepare('SELECT * FROM account').all() as {username:string;name:string;salt:string;hash:string}[];
    if(accounts.length!==1)throw new Error('Backup must contain one owner account');
    for(const account of accounts)if(!account.username||!account.name||!/^[a-f0-9]{32}$/.test(account.salt)||!/^[a-f0-9]{128}$/.test(account.hash))throw new Error('Invalid backup account');
    const records=(candidate.prepare('SELECT id,entity,data FROM records').all() as {id:string;entity:string;data:string}[]).map(row=> {
      const record=JSON.parse(row.data) as RecordData;
      if(record.id!==row.id||record.entity!==row.entity||!Number.isInteger(record.number)||record.number<1||!Number.isFinite(Date.parse(record.createdAt))||!Number.isFinite(Date.parse(record.updatedAt))||typeof record.archived!=='boolean'||!record.values)throw new Error('Invalid backup record');
      this.definition(record.entity);return record;
    });
    const ids=new Map(records.map(record=>[record.id,record]));
    for(const record of records) {
      const entity=this.definition(record.entity);
      for(const field of entity.fields) {
        const value=record.values[field.key];
        if(field.type==='number'||field.type==='money')bounds(numeric(value,field.label,!field.required&&value===0?0:(field.min??0)),field);
        else if(field.type==='checkbox') {if(typeof value!=='boolean')throw new Error('Invalid backup checkbox');}
        else if(field.type==='image')image(value);
        else if(field.type==='lines') {
          if(!Array.isArray(value)||(field.required&&!value.length))throw new Error('Invalid backup items');
          for(const line of value as Line[]) {
            const source=ids.get(line.productId);if(!source||source.entity!==field.reference)throw new Error('Invalid backup item reference');
            bounds(numeric(line.quantity,'Quantity',field.min??0.001),{...field,label:`${field.label} quantity`});numeric(line.price,'Price');text(line.name,'Item name',true);
          }
        } else {
          const string=text(value,field.label,!!field.required);
          if(field.type==='select'&&string&&!field.options?.includes(string))throw new Error('Invalid backup option');
          if(field.type==='reference'&&string&&ids.get(string)?.entity!==field.reference)throw new Error('Invalid backup reference');
          if(field.type==='date'||field.type==='datetime-local')validateDate(string,field);
        }
      }
      if(entity.workflow&&!entity.workflow.states.includes(String(record.values[entity.workflow.field])))throw new Error('Invalid backup workflow');
      this.checkDates(entity,record.values);
      if(entity.finance&&Number(record.values[entity.finance.paid])>Number(record.values[entity.finance.total]))throw new Error('Invalid backup balance');
      const financeStatus=this.financeStatus(entity,record.values);
      if(financeStatus&&entity.workflow&&!cancelled(record.values[entity.workflow.field])&&record.values[entity.workflow.field]!==financeStatus)throw new Error('Backup payment status does not match balance');
      const expected={...record.values};
      for(const calc of entity.calculations || []) {
        if(calc.op==='percent'&&Number(expected[calc.fields[1]])>100)throw new Error('Invalid backup percentage');
        const amount=calc.op==='sumLines' ? (expected[calc.fields[0]] as Line[]).reduce((sum,line)=>sum+line.quantity*line.price,0) : calc.op==='multiply' ? calc.fields.reduce((result,key)=>result*Number(expected[key] || 0),1) : calc.op==='percent' ? Number(expected[calc.fields[0]] || 0)*Number(expected[calc.fields[1]] || 0)/100 : calc.fields.reduce((sum,key)=>sum+Number(expected[key] || 0),0);
        expected[calc.target]=round(numeric(amount,calc.target));
        if(expected[calc.target]!==record.values[calc.target])throw new Error('Backup calculated totals do not match line items');
      }
    }
    for(const entity of this.config.entities) {
      const entries=records.filter(record=>record.entity===entity.key&&!record.archived);
      for(const keys of entity.unique || []) {
        const seen=new Set<string>();
        for(const record of entries) {
          if(keys.some(key=>record.values[key]===''||record.values[key]===undefined))continue;
          const key=JSON.stringify(keys.map(key=>String(record.values[key]).toLowerCase()));
          if(seen.has(key))throw new Error('Backup contains duplicate unique records');seen.add(key);
        }
      }
      const sequence=candidate.prepare('SELECT value FROM meta WHERE key=?').get(`sequence:${entity.key}`) as {value:string}|undefined;
      const maximum=Math.max(0,...records.filter(record=>record.entity===entity.key).map(record=>record.number));
      if(maximum>Number(sequence?.value || 0))throw new Error('Backup record sequence is invalid');
    }
    this.checkBookings(records);
    const payments=candidate.prepare('SELECT * FROM payments').all() as unknown as Payment[];
    for(const payment of payments) {
      const record=ids.get(payment.recordId);if(!record||record.entity!==payment.entity||!this.definition(record.entity).finance)throw new Error('Invalid backup payment reference');
      numeric(payment.amount,'Payment',0.01);method(payment.method);if(!Number.isFinite(Date.parse(payment.createdAt)))throw new Error('Invalid backup payment date');
    }
    for(const record of records) {
      const finance=this.definition(record.entity).finance;
      if(finance&&round(payments.filter(payment=>payment.recordId===record.id).reduce((sum,payment)=>sum+payment.amount,0))!==Number(record.values[finance.paid]))throw new Error('Backup payments do not match balances');
    }
    candidate.prepare('SELECT id,username,action,details,createdAt FROM audit LIMIT 1').get();
  }
  restoreFrom(source: string) {
    this.auth();if(resolve(source)===resolve(this.filePath))throw new Error('Choose a separate backup file');
    const candidate=new DatabaseSync(source,{readOnly:true});try{this.validateBackup(candidate);}finally{candidate.close();}
    const staged=`${this.filePath}.${randomUUID()}.restore`,rollback=`${this.filePath}.${randomUUID()}.previous`;
    const recovery=join(dirname(this.filePath),`before-restore-${Date.now()}-${randomUUID().slice(0,8)}.sqlite`);
    this.backupTo(recovery);copyFileSync(source,staged);this.db.close();
    let renamed=false;
    try {renameSync(this.filePath,rollback);renamed=true;renameSync(staged,this.filePath);this.connect();this.user=null;}
    catch(error) {
      if(renamed) {if(existsSync(this.filePath))unlinkSync(this.filePath);renameSync(rollback,this.filePath);}
      this.connect();throw error;
    } finally {if(existsSync(staged))unlinkSync(staged);}
    // The recovery snapshot is permanent; failure to clean a redundant old file is harmless.
    try {if(existsSync(rollback))unlinkSync(rollback);} catch {}
    return this.snapshot();
  }
}
