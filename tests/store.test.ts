import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import type { BusinessConfig, Value } from '../src/shared/types';

const config: BusinessConfig = {id:'testdesk',name:'TestDesk',category:'Test',tagline:'Test',description:'Isolated tests',color:'#123456',limitations:[],entities:[
  {key:'customers',label:'Customers',singular:'Customer',description:'Customers',primary:'name',columns:['name'],fields:[{key:'name',label:'Name',type:'text',required:true},{key:'photo',label:'Photo',type:'image'}]},
  {key:'products',label:'Products',singular:'Product',description:'Products',primary:'name',columns:['name','stock'],unique:[['name']],fields:[{key:'name',label:'Name',type:'text',required:true},{key:'price',label:'Price',type:'money',required:true},{key:'stock',label:'Stock',type:'number',required:true},{key:'capacity',label:'Capacity',type:'number',default:1,min:1}]},
  {key:'sales',label:'Sales',singular:'Sale',description:'Sales',primary:'title',columns:['title','amount'],fields:[{key:'title',label:'Title',type:'text',required:true},{key:'customer',label:'Customer',type:'reference',reference:'customers',required:true},{key:'items',label:'Items',type:'lines',reference:'products',priceField:'price',stockField:'stock',stockEffect:-1,required:true},{key:'amount',label:'Total',type:'money'},{key:'paid',label:'Paid',type:'money',default:0},{key:'paymentMethod',label:'Payment method',type:'select',options:['cash','card','bank'],default:'cash'},{key:'status',label:'Status',type:'select',options:['Open','Ready','Completed','Cancelled']}],calculations:[{target:'amount',op:'sumLines',fields:['items']}],finance:{total:'amount',paid:'paid'},workflow:{field:'status',initial:'Open',states:['Open','Ready','Completed','Cancelled'],terminal:['Completed','Cancelled']}},
  {key:'purchases',label:'Purchases',singular:'Purchase',description:'Purchases',primary:'title',columns:['title','amount'],fields:[{key:'title',label:'Title',type:'text',required:true},{key:'items',label:'Items',type:'lines',reference:'products',priceField:'price',stockField:'stock',stockEffect:1,required:true},{key:'amount',label:'Total',type:'money'},{key:'paid',label:'Paid',type:'money',default:0}],calculations:[{target:'amount',op:'sumLines',fields:['items']}],finance:{total:'amount',paid:'paid'}},
  {key:'bookings',label:'Bookings',singular:'Booking',description:'Booking',primary:'title',columns:['title','start','end'],fields:[{key:'title',label:'Title',type:'text',required:true},{key:'asset',label:'Asset',type:'reference',reference:'products',required:true},{key:'start',label:'Start',type:'date',required:true},{key:'end',label:'End',type:'date',required:true},{key:'quantity',label:'Quantity',type:'number',min:1,default:1},{key:'status',label:'Status',type:'select',options:['Reserved','Issued','Returned','Cancelled']}],workflow:{field:'status',initial:'Reserved',states:['Reserved','Issued','Returned','Cancelled'],terminal:['Returned','Cancelled']},booking:{resource:'asset',start:'start',end:'end',quantity:'quantity',capacity:'capacity',inactive:['Returned','Cancelled']}},
  {key:'fees',label:'Fees',singular:'Fee',description:'Fees',primary:'period',columns:['period'],unique:[['customer','period']],fields:[{key:'customer',label:'Customer',type:'reference',reference:'customers',required:true},{key:'period',label:'Period',type:'text',required:true},{key:'amount',label:'Total',type:'money',required:true},{key:'paid',label:'Paid',type:'money',default:0}],finance:{total:'amount',paid:'paid'}}
]};
const shop={name:'Synthetic shop',phone:'',address:'Demo street',currency:'PKR',footer:'Test only'};
function fixture(configuration=config) {
  const directory=mkdtempSync(join(tmpdir(),'business-core-test-')),file=join(directory,'business.sqlite');
  const store=new Store(file,configuration);store.setup({shop,name:'Test Owner',username:'owner',password:'test-password-123'});
  store.save('customers',null,{name:'Demo Customer'});const customer=store.snapshot().records.find(record=>record.entity==='customers')!;
  store.save('products',null,{name:'Widget',price:100,stock:10,capacity:2});const product=store.snapshot().records.find(record=>record.entity==='products')!;
  return {store,directory,file,customer,product,cleanup:()=>{try{store.close();}catch{}rmSync(directory,{recursive:true,force:true});}};
}
function sale(customer:string,product:string,extra:Record<string,Value>={}) {return {title:'Test sale',customer,items:[{productId:product,quantity:2,price:1}],paid:0,...extra};}
test('setup hashes credentials, rejects duplicate setup, hides records when logged out and persists password changes',()=>{
  const f=fixture();try {
    assert.throws(()=>f.store.setup({shop,name:'Other',username:'other',password:'test-password-123'}),/configured/);
    f.store.logout();assert.equal(f.store.snapshot().records.length,0);assert.throws(()=>f.store.save('customers',null,{name:'No access'}),/sign in/);
    assert.throws(()=>f.store.login('owner','wrong'),/Incorrect/);f.store.login('OWNER','test-password-123');
    assert.throws(()=>f.store.changePassword('wrong','new-password-123'),/incorrect/);f.store.changePassword('test-password-123','new-password-123');
    const db=new DatabaseSync(f.file,{readOnly:true});const account=db.prepare('SELECT * FROM account').get() as Record<string,string>;assert.ok(!Object.values(account).includes('new-password-123'));db.close();
    f.store.close();const reopened=new Store(f.file,config);assert.equal(reopened.snapshot().user,null);assert.throws(()=>reopened.login('owner','test-password-123'),/Incorrect/);assert.equal(reopened.login('owner','new-password-123').records.length,2);reopened.close();
  }finally{f.cleanup();}
});
test('sales use authoritative prices, payments reconcile and failed overpayment rolls back',()=>{
  const f=fixture();try {
    let snap=f.store.save('sales',null,sale(f.customer.id,f.product.id,{paid:50,paymentMethod:'card'}));let record=snap.records.find(record=>record.entity==='sales')!;
    assert.equal(record.values.amount,200);assert.equal(snap.payments[0].amount,50);assert.equal(snap.payments[0].method,'card');
    assert.equal(snap.records.find(record=>record.id===f.product.id)!.values.stock,8);
    assert.throws(()=>f.store.collect(record.id,151,'cash'),/exceeds/);assert.equal(f.store.snapshot().payments.length,1);
    snap=f.store.collect(record.id,150,'cash');record=snap.records.find(other=>other.id===record.id)!;assert.equal(record.values.paid,200);assert.equal(snap.payments.reduce((sum,p)=>sum+p.amount,0),200);
    assert.throws(()=>f.store.collect(record.id,1,'cash'),/exceeds/);assert.throws(()=>f.store.save('sales',record.id,{...record.values,paid:0}),/Collect payment/);
  }finally{f.cleanup();}
});
test('stock lines aggregate duplicate products and rollback the entire sale on overselling',()=>{
  const f=fixture();try {
    assert.throws(()=>f.store.save('sales',null,sale(f.customer.id,f.product.id,{items:[{productId:f.product.id,quantity:6,price:0},{productId:f.product.id,quantity:6,price:0}]})),/stock/);
    const snap=f.store.snapshot();assert.equal(snap.records.find(record=>record.id===f.product.id)!.values.stock,10);assert.equal(snap.records.filter(record=>record.entity==='sales').length,0);
    const result=f.store.save('sales',null,sale(f.customer.id,f.product.id));assert.equal(result.records.find(record=>record.entity==='sales')!.number,1);
  }finally{f.cleanup();}
});
test('editing and unpaid cancellation apply stock deltas once and preserve original sale prices',()=>{
  const f=fixture();try {
    let record=f.store.save('sales',null,sale(f.customer.id,f.product.id)).records.find(record=>record.entity==='sales')!;
    f.store.save('products',f.product.id,{...f.product.values,price:200,stock:8});
    let snap=f.store.save('sales',record.id,{...record.values,items:[{productId:f.product.id,quantity:3,price:999}]});record=snap.records.find(r=>r.id===record.id)!;
    assert.equal(record.values.amount,300);assert.equal(snap.records.find(r=>r.id===f.product.id)!.values.stock,7);
    snap=f.store.transition('sales',record.id,'Cancelled');assert.equal(snap.records.find(r=>r.id===f.product.id)!.values.stock,10);
    assert.throws(()=>f.store.transition('sales',record.id,'Open'),/reopened/);assert.throws(()=>f.store.save('sales',record.id,record.values),/edited/);
  }finally{f.cleanup();}
});
test('purchase receipts add stock and cannot be reduced below quantities already used',()=>{
  const f=fixture();try {
    const purchase=f.store.save('purchases',null,{title:'Incoming stock',items:[{productId:f.product.id,quantity:5,price:40}],paid:0}).records.find(r=>r.entity==='purchases')!;
    assert.equal(purchase.values.amount,200);assert.equal(f.store.snapshot().records.find(r=>r.id===f.product.id)!.values.stock,15);
    f.store.save('sales',null,sale(f.customer.id,f.product.id,{items:[{productId:f.product.id,quantity:14,price:0}]}));
    assert.throws(()=>f.store.save('purchases',purchase.id,{...purchase.values,items:[{productId:f.product.id,quantity:1,price:40}]}),/stock/);
    assert.equal(f.store.snapshot().records.find(r=>r.id===f.product.id)!.values.stock,1);
  }finally{f.cleanup();}
});
test('workflow cannot move backwards and paid cancellation is refused; completed debts remain collectible',()=>{
  const f=fixture();try {
    const record=f.store.save('sales',null,sale(f.customer.id,f.product.id,{status:'Completed',paid:10})).records.find(r=>r.entity==='sales')!;
    assert.equal(record.values.status,'Open');f.store.transition('sales',record.id,'Ready');assert.throws(()=>f.store.transition('sales',record.id,'Open'),/backwards/);
    assert.throws(()=>f.store.transition('sales',record.id,'Cancelled'),/paid/);f.store.transition('sales',record.id,'Completed');
    assert.equal(f.store.collect(record.id,190,'bank').records.find(r=>r.id===record.id)!.values.paid,200);
  }finally{f.cleanup();}
});
test('composite uniqueness and references are enforced before creating records',()=>{
  const f=fixture();try {
    assert.throws(()=>f.store.save('sales',null,sale(f.product.id,f.product.id)),/different record type/);
    assert.throws(()=>f.store.save('sales',null,sale('missing',f.product.id)),/not found/);
    f.store.save('fees',null,{customer:f.customer.id,period:'2026-10',amount:500,paid:100});
    assert.throws(()=>f.store.save('fees',null,{customer:f.customer.id,period:'2026-10',amount:500,paid:0}),/already exists/);
    assert.throws(()=>f.store.save('products',null,{name:'widget',price:1,stock:1}),/already exists/);
  }finally{f.cleanup();}
});
test('booking capacity uses peak overlap, includes date endpoints, and releases capacity on return',()=>{
  const f=fixture();try {
    const booking=(title:string,start:string,end:string,quantity=1)=>({title,asset:f.product.id,start,end,quantity});
    const first=f.store.save('bookings',null,booking('First','2026-11-01','2026-11-02')).records.find(r=>r.entity==='bookings')!;
    f.store.save('bookings',null,booking('Second','2026-11-03','2026-11-04'));
    f.store.save('bookings',null,booking('Spanning','2026-11-01','2026-11-04'));
    assert.throws(()=>f.store.save('bookings',null,booking('At endpoint','2026-11-02','2026-11-02')),/capacity/);
    assert.throws(()=>f.store.save('bookings',null,booking('Backwards','2026-11-06','2026-11-05')),/end/);
    f.store.transition('bookings',first.id,'Returned');f.store.save('bookings',null,booking('Now free','2026-11-02','2026-11-02'));
    assert.throws(()=>f.store.save('products',f.product.id,{...f.product.values,capacity:1}),/capacity/);
  }finally{f.cleanup();}
});
test('image inputs are offline and validated; malformed dates and negative payments fail',()=>{
  const f=fixture();try {
    assert.throws(()=>f.store.save('customers',null,{name:'Bad image',photo:'https://example.com/photo.jpg'}),/Image/);
    assert.throws(()=>f.store.save('customers',null,{name:'Bad image',photo:'data:image/png;base64,YmFk'}),/Image/);
    const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=';
    assert.equal(f.store.save('customers',f.customer.id,{name:'Demo Customer',photo}).records.find(r=>r.id===f.customer.id)!.values.photo,photo);
    assert.throws(()=>f.store.save('bookings',null,{title:'Invalid',asset:f.product.id,start:'2026-02-30',end:'2026-03-03',quantity:1}),/valid date/);
    assert.throws(()=>f.store.collect('none',-10,'cash'),/valid number/);
  }finally{f.cleanup();}
});
test('backups restore accounts, records, stock and payment history while rejecting another business identity',()=>{
  const f=fixture();try {
    const backup=join(f.directory,'backup.sqlite');f.store.save('sales',null,sale(f.customer.id,f.product.id,{paid:100}));f.store.backupTo(backup);
    f.store.save('customers',null,{name:'After backup'});f.store.changePassword('test-password-123','replacement-password');
    f.store.restoreFrom(backup);assert.equal(f.store.snapshot().user,null);f.store.login('owner','test-password-123');assert.equal(f.store.snapshot().records.filter(r=>r.entity==='customers').length,1);assert.equal(f.store.snapshot().payments[0].amount,100);
    const foreign=join(f.directory,'foreign.sqlite');const other=new Store(foreign,{...config,id:'otherdesk'});other.setup({shop,name:'Other',username:'other',password:'other-password'});other.close();
    assert.throws(()=>f.store.restoreFrom(foreign),/different application/);assert.equal(f.store.snapshot().user?.username,'owner');assert.throws(()=>new Store(f.file,{...config,id:'otherdesk'}),/different application/);
  }finally{f.cleanup();}
});
test('damaged payment and record backups are rejected without changing current data',()=>{
  const f=fixture();try {
    const record=f.store.save('sales',null,sale(f.customer.id,f.product.id,{paid:100})).records.find(r=>r.entity==='sales')!;
    const backup=join(f.directory,'tampered.sqlite');f.store.backupTo(backup);const db=new DatabaseSync(backup);db.exec('DELETE FROM payments');db.close();
    assert.throws(()=>f.store.restoreFrom(backup),/payments/);assert.equal(f.store.snapshot().records.find(r=>r.id===record.id)!.values.paid,100);
    const future=join(f.directory,'future.sqlite');f.store.backupTo(future);const futureDb=new DatabaseSync(future);futureDb.exec('PRAGMA user_version=999');futureDb.close();assert.throws(()=>f.store.restoreFrom(future),/version/);
  }finally{f.cleanup();}
});
test('fee states follow real payment balances and cannot be falsely marked settled',()=>{
  const configuration=structuredClone(config);
  const fee=configuration.entities.find(entity=>entity.key==='fees')!;
  fee.fields.push({key:'status',label:'Payment status',type:'select',options:['Due','Part-paid','Settled','Cancelled']});
  fee.workflow={field:'status',initial:'Due',states:['Due','Part-paid','Settled','Cancelled'],terminal:['Settled','Cancelled']};
  const f=fixture(configuration);try {
    const record=f.store.save('fees',null,{customer:f.customer.id,period:'2026-11',amount:500,paid:100}).records.find(record=>record.entity==='fees')!;
    assert.equal(record.values.status,'Part-paid');
    assert.throws(()=>f.store.transition('fees',record.id,'Settled'),/actual balance/);
    assert.equal(f.store.collect(record.id,400,'cash').records.find(other=>other.id===record.id)!.values.status,'Settled');
    const backup=join(f.directory,'fees.sqlite');f.store.backupTo(backup);f.store.restoreFrom(backup);f.store.login('owner','test-password-123');assert.equal(f.store.snapshot().records.find(other=>other.id===record.id)!.values.status,'Settled');
  }finally{f.cleanup();}
});
test('optional positive-minimum numbers can stay unspecified and calculated percentages stay within 100',()=>{
  const configuration=structuredClone(config);
  configuration.entities.find(entity=>entity.key==='products')!.fields.push({key:'year',label:'Optional year',type:'number',min:1900});
  configuration.entities.push({key:'commissions',label:'Commissions',singular:'Commission',description:'Percentage validation',primary:'title',columns:['title'],fields:[{key:'title',label:'Title',type:'text',required:true},{key:'amount',label:'Amount',type:'money',required:true},{key:'rate',label:'Commission percentage',type:'number',required:true},{key:'commission',label:'Commission',type:'money'}],calculations:[{target:'commission',op:'percent',fields:['amount','rate']}]});
  const f=fixture(configuration);try {
    assert.equal(f.product.values.year,0);
    assert.throws(()=>f.store.save('products',f.product.id,{...f.product.values,year:1800}),/1900/);
    assert.throws(()=>f.store.save('commissions',null,{title:'Invalid',amount:100,rate:101}),/100/);
    const record=f.store.save('commissions',null,{title:'Valid',amount:1000,rate:15}).records.find(record=>record.entity==='commissions')!;assert.equal(record.values.commission,150);
    const backup=join(f.directory,'optional.sqlite');f.store.backupTo(backup);assert.doesNotThrow(()=>f.store.restoreFrom(backup));
  }finally{f.cleanup();}
});
test('salon-style appointment endpoints are exclusive and true overlap is rejected',()=>{
  const configuration=structuredClone(config),booking=configuration.entities.find(entity=>entity.key==='bookings')!;
  for(const field of booking.fields)if(['start','end'].includes(field.key))field.type='datetime-local';
  const f=fixture(configuration);try {
    f.store.save('products',f.product.id,{...f.product.values,capacity:1});
    const values={title:'Appointment',asset:f.product.id,quantity:1,start:'2026-11-01T10:00',end:'2026-11-01T11:00'};
    f.store.save('bookings',null,values);
    assert.doesNotThrow(()=>f.store.save('bookings',null,{...values,start:'2026-11-01T11:00',end:'2026-11-01T12:00'}));
    assert.throws(()=>f.store.save('bookings',null,{...values,start:'2026-11-01T10:30',end:'2026-11-01T11:30'}),/capacity/);
    assert.throws(()=>f.store.save('bookings',null,{...values,end:'2026-11-01T10:00'}),/end/);
  }finally{f.cleanup();}
});
test('paid records preserve the initial payment method and ledger when edited',()=>{
  const f=fixture();try {
    const record=f.store.save('sales',null,sale(f.customer.id,f.product.id,{paid:50,paymentMethod:'card'})).records.find(record=>record.entity==='sales')!;
    assert.throws(()=>f.store.save('sales',record.id,{...record.values,paymentMethod:'cash'}),/original payment method/);
    const updated=f.store.save('sales',record.id,{...record.values,title:'Corrected description'});
    assert.equal(updated.payments[0].method,'card');assert.equal(updated.records.find(other=>other.id===record.id)!.values.paymentMethod,'card');
  }finally{f.cleanup();}
});
test('date ordering, percentage maxima and integer quantities reject invalid records atomically',()=>{
  const configuration=structuredClone(config),sales=configuration.entities.find(entity=>entity.key==='sales')!;
  sales.fields.push({key:'received',label:'Received date',type:'date',required:true},{key:'due',label:'Due date',type:'date'},{key:'rate',label:'Rate percentage',type:'number',min:0,max:100});
  sales.fields.find(field=>field.type==='lines')!.integer=true;sales.dateOrder=[['received','due']];
  const f=fixture(configuration);try {
    const valid={...sale(f.customer.id,f.product.id),received:'2026-11-02',due:'2026-11-03',rate:15};
    assert.throws(()=>f.store.save('sales',null,{...valid,due:'2026-11-01'}),/cannot be before/);
    assert.throws(()=>f.store.save('sales',null,{...valid,rate:101}),/cannot exceed/);
    assert.throws(()=>f.store.save('sales',null,{...valid,items:[{productId:f.product.id,quantity:1.5,price:100}]}),/whole number/);
    assert.equal(f.store.snapshot().records.find(record=>record.id===f.product.id)!.values.stock,10);
    const record=f.store.save('sales',null,valid).records.find(record=>record.entity==='sales')!;
    assert.equal(record.number,1);const backup=join(f.directory,'constraints.sqlite');f.store.backupTo(backup);assert.doesNotThrow(()=>f.store.restoreFrom(backup));
  }finally{f.cleanup();}
});
test('zero rental capacity blocks new bookings and cannot invalidate outstanding reservations',()=>{
  const configuration=structuredClone(config);configuration.entities.find(entity=>entity.key==='products')!.fields.find(field=>field.key==='capacity')!.min=0;
  const f=fixture(configuration);try {
    f.store.save('products',f.product.id,{...f.product.values,capacity:0});
    const values={title:'Rental',asset:f.product.id,quantity:1,start:'2026-11-01',end:'2026-11-03'};
    assert.throws(()=>f.store.save('bookings',null,values),/capacity/);
    f.store.save('products',f.product.id,{...f.product.values,capacity:1});f.store.save('bookings',null,values);
    assert.throws(()=>f.store.save('products',f.product.id,{...f.product.values,capacity:0}),/capacity/);
    assert.equal(f.store.snapshot().records.find(record=>record.id===f.product.id)!.values.capacity,1);
  }finally{f.cleanup();}
});
