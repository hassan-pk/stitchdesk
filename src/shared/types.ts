export type Value = string | number | boolean | Line[];
export interface Line { productId: string; quantity: number; price: number; name?: string }
export interface Field { key: string; label: string; type: 'text'|'textarea'|'number'|'money'|'date'|'datetime-local'|'select'|'reference'|'checkbox'|'lines'|'image'; required?: boolean; options?: string[]; reference?: string; min?: number; max?: number; integer?: boolean; default?: string|number|boolean; priceField?: string; stockField?: string; stockEffect?: 1|-1; hint?: string }
export interface Entity {
 key: string; label: string; singular: string; description: string; primary: string; fields: Field[]; columns: string[];
 workflow?: {field: string; initial: string; states: string[]; terminal: string[]};
 finance?: {total: string; paid: string};
 unique?: string[][];
 dateOrder?: [string,string][];
 booking?: {resource: string; start: string; end: string; quantity?: string; capacity?: string; inactive: string[]};
 calculations?: {target: string; op: 'sumLines'|'multiply'|'percent'|'sum'; fields: string[]}[];
}
export interface BusinessConfig { id: string; name: string; tagline: string; category: string; color: string; description: string; entities: Entity[]; limitations: string[] }
export interface RecordData {id: string; entity: string; number: number; createdAt: string; updatedAt: string; values: Record<string, Value>; archived: boolean}
export interface Payment {id: string; recordId: string; entity: string; amount: number; method: string; createdAt: string}
export interface Shop {name: string; phone: string; address: string; currency: string; footer: string}
export interface Snapshot {configured: boolean; shop: Shop|null; user: {name: string; username: string}|null; records: RecordData[]; payments: Payment[]; dataPath: string; version: string}
export interface DesktopAPI {
 snapshot(): Promise<Snapshot>;
 setup(input: {shop: Shop; name: string; username: string; password: string}): Promise<Snapshot>;
 login(username: string,password: string): Promise<Snapshot>;
 logout(): Promise<Snapshot>;
 save(entity: string,id: string|null,values: Record<string,Value>): Promise<Snapshot>;
 transition(entity: string,id: string,status: string): Promise<Snapshot>;
 collect(id: string,amount: number,method: string): Promise<Snapshot>;
 saveShop(shop: Shop): Promise<Snapshot>;
 changePassword(current: string,next: string): Promise<Snapshot>;
 exportBackup(): Promise<string|null>;
 restoreBackup(): Promise<Snapshot|null>;
 print(id: string): Promise<void>;
}
declare global {interface Window {desk: DesktopAPI}}
