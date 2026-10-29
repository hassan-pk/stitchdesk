import {contextBridge,ipcRenderer} from 'electron';
import type {DesktopAPI} from '../shared/types';
const call=(name:string,...args:unknown[])=>ipcRenderer.invoke(`desk:${name}`,...args);
const api:DesktopAPI={snapshot:()=>call('snapshot'),setup:i=>call('setup',i),login:(u,p)=>call('login',u,p),logout:()=>call('logout'),save:(e,id,v)=>call('save',e,id,v),transition:(e,id,s)=>call('transition',e,id,s),collect:(id,a,m)=>call('collect',id,a,m),saveShop:s=>call('saveShop',s),changePassword:(a,b)=>call('changePassword',a,b),exportBackup:()=>call('exportBackup'),restoreBackup:()=>call('restoreBackup'),print:id=>call('print',id)};
contextBridge.exposeInMainWorld('desk',api);
