"""Focused regression against separately recorded business reference, not implementation snapshots."""
import unittest,json,pathlib,base64,copy,importlib.util,hashlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('method',ROOT/'scripts/process_records.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Industry(unittest.TestCase):
 def payload(self):
  attachments={}
  for f in (ROOT/'examples/模拟资料').rglob('*.txt'):
   p=str(f.relative_to(ROOT/'examples'));attachments[p]={'available':True,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()}
  return {'company':json.loads((ROOT/'references/company.json').read_text()),'preferences':json.loads((ROOT/'references/preferences.json').read_text()),'name':'input.json','input':base64.b64encode((ROOT/'examples/模拟制造企业-202608-09.json').read_bytes()).decode(),'attachments':attachments}
 def test_reference(self):
  r=m.run(self.payload());ref=json.loads((ROOT/'examples/expected-reference.json').read_text())
  for k in ['bookKg','physicalKg','differenceKg']:self.assertEqual(r['summary']['inventory'][k],ref['inventory'][k])
  self.assertEqual(r['summary']['inventory']['capacityAttention'],[])
  self.assertEqual(r['summary']['inventory']['batchAttention'][0]['days'],133)
  self.assertEqual(r['summary']['ledger']['inputRows'],38);self.assertEqual(r['summary']['ledger']['uniqueRows'],37)
  self.assertEqual(r['summary']['analysisInput']['rows'],18);self.assertTrue(r['summary']['analysisInput']['complete'])
  rows={r[0]:r for r in next(x for x in r['sheets'] if x['name']=='结算对账')['rows']}
  self.assertEqual(rows['B-O08'][9],'1838');self.assertEqual(rows['B-O08'][11],'40');self.assertEqual(rows['B-O09'][9],'未提供/待核');self.assertEqual(rows['B-O09'][8],'2124')
  g=next(x for x in r['summary']['transfer']['pending'] if x['shipment']=='G09');self.assertIn('跨期',g['status'])
  self.assertEqual(r['summary']['checklist']['missing'],1);self.assertEqual(r['summary']['checklist']['incomplete'],1)
 def test_personal_method(self):
  p=self.payload();p['preferences'].update(methods=['inventory'],capacityPercent='80',differencesOnly=True)
  r=m.run(p);self.assertEqual([s['name'] for s in r['sheets']],['库存差异']);self.assertEqual(r['summary']['inventory']['capacityAttention'][0]['warehouse'],'GW_MAIN');self.assertEqual(r['summary']['inventory']['capacityAttention'][0]['thresholdPercent'],'80')
 def test_missing_weight_cannot_become_verified_zero(self):
  p=self.payload();data=json.loads(base64.b64decode(p['input']));data['tables']['events'][0]['unit']='';data['tables']['events'][-1]['unit']=''
  p['input']=base64.b64encode(json.dumps(data).encode()).decode();r=m.run(p)
  self.assertFalse(r['summary']['analysisInput']['complete']);self.assertTrue(any(i['code']=='WEIGHT_OR_UNIT_MISSING' for i in r['issues']))
 def test_contract_quote_unverified_holds_amount(self):
  p=self.payload();p['unverifiedContracts']=['模拟资料/合同/C-G.txt'];r=m.run(p)
  rows=next(x for x in r['sheets'] if x['name']=='结算对账')['rows'];self.assertEqual(rows[0][9],'未提供/待核');self.assertIn('原文未核实',rows[0][13])
 def test_conflicting_duplicate_not_first_wins(self):
  p=self.payload();data=json.loads(base64.b64decode(p['input']));data['tables']['events'][18]['weight']=999
  p['input']=base64.b64encode(json.dumps(data).encode()).decode();r=m.run(p);self.assertFalse(r['summary']['analysisInput']['complete']);self.assertTrue(any(i['code']=='CONFLICTING_DUPLICATE' for i in r['issues']))
 def test_structured_contract_rate_conflict(self):
  p=self.payload();data=json.loads(base64.b64decode(p['input']));data['tables']['contracts'][0]['rate']=999
  p['input']=base64.b64encode(json.dumps(data).encode()).decode();r=m.run(p);rows=next(x for x in r['sheets'] if x['name']=='结算对账')['rows'];self.assertEqual(rows[0][9],'未提供/待核');self.assertIn('不一致',rows[0][13])
if __name__=='__main__':unittest.main()
