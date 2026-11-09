# Build small read-only delegated review artifacts from frozen final outputs, never a human/medical approval.
from pathlib import Path
import json,html,hashlib,datetime,os,sys
root=Path(__file__).resolve().parents[4];original_base=Path(__file__).parent;
base=(root/sys.argv[1]).resolve();assert base.is_relative_to(root)
source_pages_base=(root/sys.argv[2]).resolve() if len(sys.argv)>2 else original_base/'original-pages';assert source_pages_base.is_relative_to(root)
out=base/'review';out.mkdir(exist_ok=True)
plan=json.loads((base/'plan.json').read_text());papers={p['source_id']:p for p in plan['inputs']}
randoms=[];risks=[];sources=[]
for source_id in papers:
 material_path=base/(source_id+'-review-material.json');result_path=base/(source_id+'-result.json')
 if not material_path.exists() or not result_path.exists():continue
 material=json.loads(material_path.read_text());result=json.loads(result_path.read_text());delivery=json.loads((base/(source_id+'-delivery.json')).read_text());raw_result_path=root/Path(result['ledger']).parent/'result.json'
 raw=json.loads(raw_result_path.read_text()) if raw_result_path.exists() else {};versions={}
 for v in raw.get('versions',raw.get('records',[])):
  id=v['record']['record_id']
  if id not in versions or v['version']>versions[id]['version']:versions[id]=v
 figures={f['figure_id']:f for f in delivery['figures']}
 def case(record,case_id,reasons=None):
  pages=sorted(set(f['physical_page'] for f in record['original_fragments']+record['context_fragments']))
  linked=[]
  for id in dict.fromkeys(record['figure_association']['figure_ids']+record['figure_association']['proposed_figure_ids']):
   figure=figures.get(id)
   if not figure:continue
   pages=sorted(set(pages+[f['physical_page'] for f in figure['caption_segments']]+[a['physical_page'] for a in figure['regions']]))
   linked.append({'figure_id':id,'figure_number':figure['figure_number'],'association_status':record['figure_association']['status'],'verification':figure['verification'],'caption_fragments':figure['caption_segments'],'assets':[{'path':a['path'],'sha256':a['sha256'],'physical_page':a['physical_page'],'bbox':a['bbox'],'width_px':a['width_px'],'height_px':a['height_px']} for a in figure['regions']]})
  return {'case_id':case_id,'source_id':source_id,'source_title':papers[source_id]['title'],'source_pdf':papers[source_id]['path'],'file_sha256':papers[source_id]['sha256'],'record':record,'raw_fields':versions.get(record['record_id'],{}).get('record'),'source_pages':[{'physical_page':p,'png_path':str((source_pages_base/f'{source_id}-p{p:03d}.png').relative_to(root))} for p in pages],'linked_figures':linked,'directed_risk_reasons':reasons or [],'reviewer_kind':'delegated_ai_operator','review_status':'pending','human_medical_approval':False}
 for i,record in enumerate(material['random_records'],1):randoms.append(case(record,f'{source_id}-R{i:02d}'))
 for i,risk in enumerate(material['directed_risks'],1):
  c=case(risk['record'],f'{source_id}-D{i:02d}',risk['reasons']);c['also_in_random_sample']=risk['also_in_random_sample'];risks.append(c)
 sources.append({'source_id':source_id,'output_count':material['output_count'],'primary_count':result['primary_count'],'background_count':result['background_count'],'random_count':material['random_sample_count'],'random_denominator':material['random_denominator'],'directed_risks':len(material['directed_risks']),'task_processing_complete':result['task_processing_complete'],'parser_status':result['parser_status'],'parser_limits':result['parser_limits']})
pack={'schema_version':'s6-delegated-source-review-pack-1','repaired_version_boundary':plan['protocol'].get('version_boundary'),'prepared_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'frozen_plan_sha256':hashlib.sha256((base/'plan.json').read_bytes()).hexdigest(),'seed':plan['seed'],'reviewer_kind':'delegated_ai_operator','medical_quality_approved':False,'product_export_approved':False,'actual_human_reviewed_count':0,'sources_ready':sources,'source_page_observations':json.loads((base/'source-observations.json').read_text()) if (base/'source-observations.json').exists() else None,'random_sample_count':len(randoms),'directed_risk_count':len(risks),'random_cases':randoms,'directed_risks':risks,'source_order_rule':'Each fragment stays separate and exactly as delivered. Case/page/negation/time/attribution/figure identities are ordinary source observations, not clinical correctness or recall.'}
(out/'pack.json').write_text(json.dumps(pack,ensure_ascii=False,indent=2)+'\n')
e=lambda s:html.escape(str(s),quote=True)
url=lambda p:e(os.path.relpath(root/p,out))
def render(cases,title,directed=False):
 sections=[]
 for c in cases:
  r=c['record'];fragments=[]
  for role,key in [('原文','original_fragments'),('必要语境','context_fragments')]:
   for n,f in enumerate(r[key],1):fragments.append(f'<article><b>{role} {n} · 物理页 {f["physical_page"]}</b><pre>{e(f["exact_quote"])}</pre><small>{e(f["block_id"])} · [{f["start"]},{f["end"]}) · {e(f["text_version"])}</small></article>')
  imgs=''.join(f'<a href="{url(p["png_path"])}">{c["source_id"]} 原页 {p["physical_page"]}</a> ' for p in c['source_pages'])
  figures=[]
  for f in c['linked_figures']:
   caption=''.join(f'<article><b>原图注 · 物理页 {x["physical_page"]}</b><pre>{e(x["exact_quote"])}</pre></article>' for x in f['caption_fragments'])
   assets=''.join(f'<p><a href="{url(a["path"])}">原尺寸图候选 · 页{a["physical_page"]}</a></p><img src="{url(a["path"])}" alt="原图候选，完整性与关联未获医学批准">' for a in f['assets'])
   figures.append(f'<details><summary>Figure {e(f["figure_number"])} · 自动关联 {e(f["association_status"])} · 原核验状态 {e(f["verification"]["status"])}</summary>{assets}{caption}</details>')
  risk=f'<p class="notice">定向风险，单独统计：{e(" / ".join(c["directed_risk_reasons"]))}；与随机重叠：{c.get("also_in_random_sample",False)}</p>' if directed else ''
  fields=f'<details><summary>原始候选字段（模型建议）</summary><pre>{e(json.dumps(c["raw_fields"],ensure_ascii=False,indent=2))}</pre></details>' if c['raw_fields'] else ''
  sections.append(f'<section id="{e(c["case_id"])}"><h2>{e(c["case_id"])} · {e(c["source_id"])}</h2><p>{e(c["source_title"])}</p><p>{e(r["record_id"])} @v{r["record_version"]} · 当前交付指纹 {e(r["delivery_fingerprint"])}</p>{risk}<p>{imgs} · <a href="{url(c["source_pdf"])}">原PDF</a></p>{"".join(fragments)}<p>自动图状态：{e(r["figure_association"]["status"])}。无图不否定文字；pending不能当作已确认配对。</p>{"".join(figures)}{fields}<p><a href="#top">返回目录</a></p></section>')
 nav=' '.join(f'<a href="#{e(c["case_id"])}">{e(c["case_id"])}</a>' for c in cases)
 return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'"><title>{e(title)}</title><style>body{{font:15px/1.7 Arial,sans-serif;max-width:1050px;margin:auto;padding:24px;color:#17212c}}a{{color:#245bce}}section{{border-top:2px solid #d1d5db;margin-top:26px;padding-top:12px}}article{{border:1px solid #d1d5db;margin:12px 0;padding:12px}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.75 monospace}}small{{color:#566273}}img{{max-width:100%;height:auto}}summary{{cursor:pointer}}.notice{{background:#fff4dd;padding:12px}}</style></head><body id="top"><h1>{e(title)}</h1><p class="notice">S6固定独立输入；代理仅核对普通原文、出处、语境及明确图文对应。真人审核数0，不认证医学正确性、总体准确率或召回；不批准产品记录。随机与定向风险分别统计。</p><p>种子 {e(plan['seed'])}；随机样本含全部交付primary/background，类型分列，0输出分母N/A。</p><nav>{nav}</nav>{''.join(sections)}</body></html>'''
(out/'random-review.html').write_text(render(randoms,'S6独立输出：固定随机样本'),encoding='utf8');(out/'directed-risks.html').write_text(render(risks,'S6独立输出：定向风险（单列）',True),encoding='utf8')
print(json.dumps({'ready_sources':[s['source_id'] for s in sources],'random_cases':len(randoms),'directed_risks':len(risks),'pack':str((out/'pack.json').relative_to(root))}))
