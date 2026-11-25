// Completely generated catalog. No external data or production identifiers.
export const kinds = ['title', 'alias', 'tag'];
const objects = ['desk','lamp','chair','shelf','table','vase','basket','cabinet','clock','bench','mirror','rug'];
const colors = ['blue','green','red','amber','white','black','silver','violet','oak','teal','copper'];
const localized = ['โต๊ะไม้','โคมไฟ','เก้าอี้','ชั้นวาง','โต๊ะพับ','แจกัน','ตะกร้า','ตู้ไม้','นาฬิกา','ม้านั่ง','กระจก','พรม'];
export function makeDocuments(count = 10000) {
  return Array.from({ length: count }, (_, i) => ({
    id: 'item-'+String(i).padStart(8,'0'),
    names: [
      { kind:'title', text: colors[Math.floor(i/objects.length)%colors.length]+' '+objects[i%objects.length]+' series '+(i%251) },
      { kind:'alias', text: localized[i%localized.length]+' รุ่น '+(i%137) },
      { kind:'tag', text: 'catalog '+(i%31) },
    ],
  }));
}
export const queries = ['blue desk','desk series 23','series','โคมไฟ','รุ่น 42','ตู้','chair 23','amber','zzabsent','cab','blue','🪴','d','oak clock','catalog 17'];
