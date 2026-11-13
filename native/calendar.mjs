export const SHANGHAI = 'Asia/Shanghai';
const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone:SHANGHAI, year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', hourCycle:'h23',
});
export function dayTime(at = new Date()) {
  const p = Object.fromEntries(calendar.formatToParts(at).map(({type,value})=>[type,value]));
  return {day:`${p.year}-${p.month}-${p.day}`, time:`${p.hour}:${p.minute}`};
}
