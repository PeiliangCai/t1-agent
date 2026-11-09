# Render source pages unchanged for delegated acceptance review. No OCR/model or source mutation.
from pathlib import Path
import json,hashlib,datetime
import pypdfium2 as pdfium
from PIL import Image,ImageDraw
root=Path(__file__).resolve().parents[5];base=root/'docs/acceptance/finalization-2026-11-09/s6';out=base/'original-pages';out.mkdir(exist_ok=True)
manifest=json.loads((root/'evaluation/manifests/independent-intake.json').read_text());report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'purpose':'Delegated independent source-page preview; never fed back into prompts or tuning','model_calls':0,'source_modified':False,'pages':[],'contact_sheets':[]}
selected={'IN01':[2,3,4,5],'IN02':[2,3,4],'IN03':[1,2,3]}
for source in manifest['papers']:
 id=source['source_id'];p=root/source['file']['path'];assert hashlib.sha256(p.read_bytes()).hexdigest()==source['file']['sha256'];doc=pdfium.PdfDocument(p);thumbs={}
 for n in range(len(doc)):
  page=doc[n];bitmap=page.render(scale=1.5);image=bitmap.to_pil().convert('RGB');file=out/f'{id}-p{n+1:03d}.png';image.save(file);report['pages'].append({'source_id':id,'physical_page':n+1,'path':str(file.relative_to(root)),'width':image.width,'height':image.height,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
  if n+1 in selected[id]:
   thumb=image.copy();thumb.thumbnail((700,1000));thumbs[n+1]=thumb
  image.close();bitmap.close();page.close()
 doc.close();cols=2;rows=(len(thumbs)+cols-1)//cols;sheet=Image.new('RGB',(cols*720,rows*1040),'white');draw=ImageDraw.Draw(sheet)
 for i,(n,thumb) in enumerate(thumbs.items()):
  x=(i%cols)*720+10;y=(i//cols)*1040;draw.text((x+5,y+5),f'{id} - original physical page {n}',fill='black');sheet.paste(thumb,(x,y+28));thumb.close()
 file=out/f'{id}-contact.png';sheet.save(file);sheet.close();report['contact_sheets'].append({'source_id':id,'physical_pages':selected[id],'path':str(file.relative_to(root)),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
(base/'original-page-rendering.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'rendered':len(report['pages']),'contacts':report['contact_sheets']}))
