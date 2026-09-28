export type Trip={arrival:string;departure:string;beds:number;extras:Record<string,number>};
export type OrderInput=Trip & {customer:{name:string;phone:string};comment:string;consent:true;expectedTotalMinor:number;pricingVersion:number;trackingToken:string};
const date={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'};
const quantity={type:'integer',minimum:0,maximum:100};
export const tripProperties={arrival:date,departure:date,beds:{type:'integer',minimum:0,maximum:20},extras:{type:'object',maxProperties:30,propertyNames:{pattern:'^(?!bed$)[a-z][a-z0-9_-]{0,39}$'},additionalProperties:quantity}};
export const tripSchema={type:'object',additionalProperties:false,required:['arrival','departure','beds','extras'],properties:tripProperties};
export const orderSchema={type:'object',additionalProperties:false,required:[...tripSchema.required,'customer','comment','consent','expectedTotalMinor','pricingVersion','trackingToken'],properties:{...tripProperties,
  customer:{type:'object',additionalProperties:false,required:['name','phone'],properties:{name:{type:'string',minLength:1,maxLength:80},phone:{type:'string',minLength:10,maxLength:30}}},
  comment:{type:'string',maxLength:1000},consent:{const:true},expectedTotalMinor:{type:'integer',minimum:1},pricingVersion:{type:'integer',minimum:1},trackingToken:{type:'string',pattern:'^[a-f0-9]{64}$'}
}};
export class AppError extends Error { constructor(public statusCode:number, public code:string,message:string){super(message)} }
