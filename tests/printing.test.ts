import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentHTML} from '../src/shared/printing';
import type {BusinessConfig,Snapshot,RecordData} from '../src/shared/types';
const config:BusinessConfig={id:'test',name:'TestDesk',tagline:'Test',category:'Test',color:'#123456',description:'Test',limitations:[],entities:[{key:'jobs',label:'Jobs',singular:'Job',primary:'name',description:'Test',columns:['name'],fields:[{key:'name',label:'Name',type:'text'},{key:'amount',label:'Total',type:'money'},{key:'paid',label:'Paid',type:'money'}],finance:{total:'amount',paid:'paid'}}]};
test('documents escape business and record fields and show balances',()=>{const record:RecordData={id:'1',entity:'jobs',number:3,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false,values:{name:'<script>unsafe</script>',amount:100,paid:20}};const snapshot:Snapshot={configured:true,shop:{name:'<img src=x>',phone:'',address:'',currency:'PKR',footer:'<script>footer</script>'},user:{name:'Owner',username:'owner'},records:[record],payments:[],dataPath:'test',version:'0.1.0'};const html=documentHTML(config,snapshot,record);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;unsafe'));assert.ok(html.includes('PKR 80.00'));assert.ok(html.includes('Job #3'));});

function record(id:string,entity:string,values:RecordData['values']):RecordData{return {id,entity,number:1,createdAt:'2030-01-01T12:00:00Z',updatedAt:'2030-01-01T12:00:00Z',archived:false,values};}
function snapshot(records:RecordData[]):Snapshot{return {configured:true,shop:{name:'Demo business',phone:'',address:'',currency:'PKR',footer:'Demo footer'},user:{name:'Demo owner',username:'demo'},records,payments:[],dataPath:'temporary',version:'0.1.0'};}

test('job documents resolve customer identity through vehicles, profiles and reference-primary records',()=>{
 const configuration:BusinessConfig={...config,entities:[
  {key:'customers',label:'Customers',singular:'Customer',description:'Customers',primary:'name',columns:[],fields:[{key:'name',label:'Name',type:'text'},{key:'phone',label:'Phone',type:'text'}]},
  {key:'vehicles',label:'Vehicles',singular:'Vehicle',description:'Vehicles',primary:'registration',columns:[],fields:[{key:'registration',label:'Registration',type:'text'},{key:'customer',label:'Customer',type:'reference',reference:'customers'}]},
  {key:'profiles',label:'Profiles',singular:'Profile',description:'Profiles',primary:'name',columns:[],fields:[{key:'name',label:'Profile name',type:'text'},{key:'customer',label:'Customer',type:'reference',reference:'customers'}]},
  {key:'attendance',label:'Attendance',singular:'Attendance',description:'Attendance',primary:'student',columns:[],fields:[{key:'student',label:'Student',type:'reference',reference:'customers'}]},
  {key:'jobs',label:'Jobs',singular:'Job',description:'Jobs',primary:'title',columns:[],fields:[{key:'title',label:'Title',type:'text'},{key:'vehicle',label:'Vehicle',type:'reference',reference:'vehicles'},{key:'profile',label:'Measurement profile',type:'reference',reference:'profiles'},{key:'attendance',label:'Attendance reference',type:'reference',reference:'attendance'}]}
 ]};
 const customer=record('private-customer-id','customers',{name:'Sample <Customer>',phone:'000-000-0000'});
 const vehicle=record('private-vehicle-id','vehicles',{registration:'DEMO-123',customer:customer.id});
 const profile=record('private-profile-id','profiles',{name:'Formal shirt',customer:customer.id});
 const attendance=record('private-attendance-id','attendance',{student:customer.id});
 const job=record('job-id','jobs',{title:'Service',vehicle:vehicle.id,profile:profile.id,attendance:attendance.id});
 const html=documentHTML(configuration,snapshot([customer,vehicle,profile,attendance,job]),job);
 assert.ok(html.includes('DEMO-123'));assert.ok(html.includes('Formal shirt'));assert.ok(html.includes('Sample &lt;Customer&gt;'));assert.ok(html.includes('000-000-0000'));
 for(const hidden of [customer.id,vehicle.id,profile.id,attendance.id])assert.ok(!html.includes(hidden));
});

test('cancelled unpaid documents show no collectible balance and preserve zero numeric values',()=>{
 const configuration=structuredClone(config),entity=configuration.entities[0];
 entity.fields.push({key:'status',label:'Status',type:'select',options:['Open','Cancelled']},{key:'stock',label:'Stock',type:'number'});
 entity.workflow={field:'status',initial:'Open',states:['Open','Cancelled'],terminal:['Cancelled']};
 const job=record('job-id','jobs',{name:'Cancelled example',amount:500,paid:0,status:'Cancelled',stock:0});
 const html=documentHTML(configuration,snapshot([job]),job);
 assert.ok(html.includes('Outstanding: PKR 0.00'));assert.ok(!html.includes('Outstanding: PKR 500.00'));
 assert.ok(html.includes('<th>Stock</th><td>0</td>'));
});

test('cyclic reference labels terminate without exposing internal ids',()=>{
 const configuration:BusinessConfig={...config,entities:[{key:'loop',label:'Loop',singular:'Loop',description:'Loop',primary:'parent',columns:[],fields:[{key:'parent',label:'Parent',type:'reference',reference:'loop'}]}]};
 const cyclic=record('internal-cycle-id','loop',{parent:'internal-cycle-id'});
 const html=documentHTML(configuration,snapshot([cyclic]),cyclic);
 assert.ok(html.includes('#1'));assert.ok(!html.includes('internal-cycle-id'));
});
