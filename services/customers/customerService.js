const mongoose = require('mongoose');
const httpError = require('http-errors');
const Customer = require('../../models/customerModel');
const Tenant = require('../../models/tenantModel');
const normalizeName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
const taxKey = value => value?.valueNormalized ? `${value.countryCode}:${value.valueNormalized}` : '';
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
function taxFromBody(body) {
    if (own(body,'taxIdentity')) return Customer.normalizeTaxIdentity(body.taxIdentity);
    const value = body.rncCedula || body.rnc;
    return value ? Customer.normalizeTaxIdentity({countryCode:'DO',type:String(value).replace(/\D/g,'').length===11?'CEDULA':'RNC',value}) : null;
}
function fail(code, status=409) { throw httpError(status,code); }
async function writeCustomer({tenantId,clientId,id,body={},deactivate=false}) {
    if (!tenantId) fail('TENANT_REQUIRED',403);
    if (id && !mongoose.isValidObjectId(id)) fail('INVALID_CUSTOMER_ID',400);
    const session = await mongoose.startSession();
    let result;
    try {
        await session.withTransaction(async()=>{
            // Serialize customer writes across processes and branches without imposing
            // unique-name indexes on legacy customers or merging existing homonyms.
            const lock = await Tenant.updateOne({tenantId,status:'active'},{$inc:{__v:1}},{session,timestamps:false});
            if (!lock.matchedCount) fail('TENANT_UNAVAILABLE',403);
            const customer = id ? await Customer.findOne({_id:id,tenantId,clientId}).session(session) : new Customer({tenantId,clientId});
            if (!customer) fail('CUSTOMER_NOT_FOUND',404);
            if (deactivate) { customer.isActive=false; await customer.save({session}); result=customer; return; }
            if (id && customer.isActive===false) fail('CUSTOMER_INACTIVE',409);
            const oldName=normalizeName(customer.name),oldTax=taxKey(customer.taxIdentity),oldPhone=customer.phoneNormalized;
            for (const field of ['name','phone','address']) if (own(body,field)) customer[field]=String(body[field]??'').trim();
            if (!id && !own(body,'name')) fail('NAME_REQUIRED',400);
            if (!customer.name?.trim()) fail('NAME_REQUIRED',400);
            if (customer.name.length>200 || customer.phone.length>80 || customer.address.length>1000) fail('CUSTOMER_FIELD_TOO_LONG',400);
            if (['taxIdentity','rnc','rncCedula'].some(k=>own(body,k))) customer.taxIdentity=taxFromBody(body);
            const name=normalizeName(customer.name),tax=taxKey(customer.taxIdentity),phone=Customer.normalizePhone(customer.phone);
            const peers=await Customer.find({tenantId,_id:{$ne:customer._id},isActive:{$ne:false}}).session(session).lean();
            if ((!id || oldPhone!==phone) && phone && peers.some(p=>p.clientId===clientId && Customer.normalizePhone(p.phone)===phone)) fail('PHONE_ALREADY_EXISTS');
            if ((!id || oldTax!==tax) && tax && peers.some(p=>taxKey(Customer.normalizeTaxIdentity(p.taxIdentity))===tax)) fail('TAX_ID_ALREADY_EXISTS');
            const homonyms=peers.filter(p=>normalizeName(p.name)===name);
            if ((!id || oldName!==name || oldTax!==tax) && homonyms.length) {
                // Distinct identity must be verifiable against every matching name.
                if (!tax || !customer.taxIdentity?.countryCode || homonyms.some(p=>{
                    const identity=Customer.normalizeTaxIdentity(p.taxIdentity);
                    return !identity?.countryCode || !taxKey(identity) || taxKey(identity)===tax;
                })) fail('NAME_ALREADY_EXISTS');
                if (body.confirmDistinctPerson!==true) fail('HOMONYM_CONFIRMATION_REQUIRED');
            }
            await customer.save({session}); result=customer;
        });
        return result;
    } finally { await session.endSession(); }
}
module.exports={normalizeName,writeCustomer};
