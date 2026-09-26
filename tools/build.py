#!/usr/bin/env python3
"""
Rebuild the app's game data and public/index.html.

  python3 tools/build.py            download the latest Deadlock game files and rebuild everything
  python3 tools/build.py --offline  just re-embed data/gamedata.json + data/tracklock-snapshot.json into public/index.html

Game data comes from SteamDB's GameTracking-Deadlock repository on GitHub, which mirrors
Valve's files every patch. Only the Python 3 standard library is needed.
"""
import json, re, os, sys, copy, html, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
GT = 'https://raw.githubusercontent.com/SteamDatabase/GameTracking-Deadlock/master/'
FILES = {
    'abilities': 'game/citadel/pak01_dir/scripts/abilities.vdata',
    'heroes': 'game/citadel/pak01_dir/scripts/heroes.vdata',
    'generic': 'game/citadel/pak01_dir/scripts/generic_data.vdata',
}
LOC_FILES = ['citadel_gc_mod_names', 'citadel_gc_hero_names', 'citadel_mods', 'citadel_attributes', 'citadel_heroes', 'citadel_main', 'citadel_gc']

def get(path):
    print('  downloading', path.split('/')[-1])
    req = urllib.request.Request(GT + path, headers={'User-Agent': 'Buildlock/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode('utf-8-sig', errors='replace')

# ---------------------------------------------------------------- KV3 parser
TOK = re.compile(r'''
 (?P<ws>\s+)|
 (?P<c1>//[^\n]*)|(?P<c2>/\*.*?\*/)|
 (?P<ml>""".*?""")|
 (?P<str>"(?:[^"\\]|\\.)*")|
 (?P<punct>[{}\[\]=,])|
 (?P<flag>[A-Za-z_]+:(?=\s*["{\[]))|
 (?P<atom>[^\s{}\[\]=,"]+)
''', re.S|re.X)
def tokenize(s):
    s = re.sub(r'^<!--.*?-->', '', s, flags=re.S)
    for m in TOK.finditer(s):
        k=m.lastgroup
        if k in ('ws','c1','c2','flag'): continue
        v=m.group()
        if k=='ml': yield ('s', v[3:-3].strip('\n'))
        elif k=='str': yield ('s', v[1:-1].replace('\\"','"').replace('\\n','\n'))
        elif k=='punct': yield ('p', v)
        else: yield ('a', v)
def parse(s):
    toks=list(tokenize(s)); i=0
    def val():
        nonlocal i
        t,v=toks[i]; i+=1
        if t=='p' and v=='{':
            d={}
            while True:
                t,v=toks[i]
                if t=='p' and v=='}': i+=1; return d
                if t=='p' and v==',': i+=1; continue
                key=v; i+=1
                assert toks[i]==('p','='), (key,toks[i-3:i+3]); i+=1
                d[key]=val()
        if t=='p' and v=='[':
            a=[]
            while True:
                t,v=toks[i]
                if t=='p' and v==']': i+=1; return a
                if t=='p' and v==',': i+=1; continue
                a.append(val())
        if t=='s': return v
        if v=='true': return True
        if v=='false': return False
        if v=='null': return None
        try: return int(v)
        except: pass
        try: return float(v)
        except: return v
    return val()

# ---------------------------------------------------------------- helpers
def deepmerge(base, over):
    r = copy.deepcopy(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(r.get(k), dict): r[k] = deepmerge(r[k], v)
        else: r[k] = copy.deepcopy(v)
    return r
_cache = {}
def resolve(db, key):
    ck = (id(db), key)
    if ck in _cache: return _cache[ck]
    e = db[key]; bases = []
    if '_base' in e: bases.append(e['_base'])
    bases += e.get('_multibase', []) or []
    r = {}
    for b in bases:
        if b in db: r = deepmerge(r, resolve(db, b))
    r = deepmerge(r, {k: v for k, v in e.items() if k not in ('_base', '_multibase')})
    _cache[ck] = r; return r
def num(s):
    if isinstance(s, (int, float)): return float(s)
    m = re.match(r'^\s*(-?[\d.]+)', str(s)); return float(m.group(1)) if m else None
def cdn(p):
    if not p: return ''
    p = p.replace('file://{images}/', '')
    if p.startswith('hud/'): p = p[4:]
    return re.sub(r'\.(psd|png|tga)$', '.webp', p)
slug = lambda n: n.lower().replace('&', 'and').replace(' ', '-')

def extract():
    global a, h, g, LOC
    print('Downloading game files from GameTracking-Deadlock...')
    a = parse(get(FILES['abilities'])); h = parse(get(FILES['heroes'])); g = parse(get(FILES['generic']))
    LOC = {}
    for n in LOC_FILES:
        try: txt = get(f'game/citadel/resource/localization/{n}/{n}_english.txt')
        except Exception as e: print('   skipped', n, e); continue
        for m in re.finditer(r'^\s*"([^"]+)"\s+"((?:[^"\\]|\\.)*)"', txt, re.M):
            k = m.group(1)
            if k.endswith(':n'): k = k[:-2]
            LOC.setdefault(k, m.group(2).replace('\\"', '"'))
    PRICE=g['m_nItemPricePerTier']
    def L(k,d=None):
        return LOC.get(k.lstrip('#'),d)
    def clean(s,props=None,fmt=None):
        if not s: return ''
        s=s.replace('\\n','\n').replace('<br>','\n').replace('<BR>','\n')
        def sub(m):
            p=m.group(1)
            if props and p in props:
                v=num(props[p].get('m_strValue'))
                if v is None: return p
                return ('%g'%round(abs(v) if m.group(0).startswith('{s') and False else v,2))
            return ''
        s=re.sub(r"\{g:citadel_inline_attribute:'?([A-Za-z_]+)'?\}", lambda m: (L('InlineAttribute_'+m.group(1)) or re.sub(r'(?<!^)(?=[A-Z])',' ',m.group(1))), s)
        s=re.sub(r'\{[sd]:([A-Za-z0-9_]+)\}', sub, s)
        s=re.sub(r'\{[^}]*\}','',s)
        s=re.sub(r'<[^>]+>','',s)
        s=html.unescape(s)
        s=re.sub(r'[ \t]+',' ',s)
        return s.strip()
    UNITS={'EDisplayUnit_Meters':'m','EDisplayUnit_MetersPerSecond':'m/s'}
    def plabel(owner,p):
        for k in (f'{owner}_{p}_label',f'{p}_label'):
            if k in LOC: return clean(LOC[k])
        return re.sub(r'(?<!^)(?=[A-Z])',' ',p)
    def pfix(owner,p,pp):
        post=LOC.get(f'{owner}_{p}_postfix', LOC.get(f'{p}_postfix'))
        if post is None:
            post=UNITS.get(pp.get('m_eDisplayUnits'),'')
            if not post and ('Percent' in p or 'Pct' in p): post='%'
            if not post and str(pp.get('m_strValue','')).endswith('m'): post='m'
        pre=LOC.get(f'{p}_prefix','')
        return pre.replace('{s:sign}','+'), clean(post) if post else ''
    def prop(owner,p,pp):
        v=num(pp.get('m_strValue'))
        pre,post=pfix(owner,p,pp)
        d={'k':p,'l':plabel(owner,p),'v':v,'u':post}
        if pp.get('m_eProvidedPropertyType'): d['t']=pp['m_eProvidedPropertyType'].replace('MODIFIER_VALUE_','')
        if pp.get('m_eStatsUsageFlags') and 'Conditional' in pp['m_eStatsUsageFlags']: d['c']=1
        sf=pp.get('m_subclassScaleFunction') or {}
        if sf.get('m_eSpecificStatScaleType') and sf.get('m_flStatScale'): d['sc']=[sf['m_eSpecificStatScaleType'],sf['m_flStatScale']]
        elif sf.get('m_eSpecificStatScaleType'): d['sc']=[sf['m_eSpecificStatScaleType'],0]
        elif sf.get('m_vecScalingStats'): d['sc']=[sf['m_vecScalingStats'][-1],0]
        css=pp.get('m_strCSSClass')
        if css: d['css']=css
        return d
    SLOT={'EItemSlotType_WeaponMod':'W','EItemSlotType_Armor':'V','EItemSlotType_Tech':'S'}
    # Only items buyable in a standard match: disabled (retired) items and tier 5 (Street Brawl legendaries) are skipped.
    def disabled(r): return r.get('m_bDisabled') not in (None,False,'false')
    def standard(r): return r.get('m_iItemTier') and r['m_iItemTier']!='EModTier_5' and not disabled(r)
    shop=[]; seen=set()
    for k in ('m_vecWeaponGroups','m_vecArmorGroups','m_vecSpiritGroups'):
        for grp in g[k]:
            for u in grp.get('m_vecUpgrades',[]):
                if u in a and u not in seen and standard(resolve(a,u)): shop.append((u,grp.get('m_eShopGroup',''))); seen.add(u)
    for k,v in a.items():
        if k in seen or not isinstance(v,dict) or v.get('_not_pickable') is not None: continue
        r=resolve(a,k)
        if r.get('m_eAbilityType')!='EAbilityType_Item' or not standard(r): continue
        if r.get('_editor',{}).get('folder_name')=='Base' or k not in LOC: continue
        act=r.get('m_eAbilityActivation') not in (None,'CITADEL_ABILITY_ACTIVATION_PASSIVE')
        shop.append((k,'EActives' if act else 'EMisc'))
    items=[]
    for iid,group in shop:
        r=resolve(a,iid); P=r.get('m_mapAbilityProperties',{})
        tier=int(r['m_iItemTier'][-1])
        it={'id':iid,'n':L(iid,iid).strip(),'s':SLOT[r['m_eItemSlotType']],'t':tier,'c':PRICE[tier],
            'g':group[1:] if group.startswith('E') else group,
            'a':0 if r.get('m_eAbilityActivation') in (None,'CITADEL_ABILITY_ACTIVATION_PASSIVE') else 1,
            'd':clean(L(iid+'_desc',''),P)}
        comp=r.get('m_vecComponentItems') or []
        if comp: it['cp']=[c for c in comp]
        if r.get('m_vecDisabledOnHeroes'): it['dh']=r['m_vecDisabledOnHeroes']
        secs=[]
        for s in r.get('m_vecTooltipSectionInfo',[]) or []:
            st=s.get('m_eAbilitySectionType','').replace('EArea_','')
            sec={'ty':st,'p':[]}
            for at in s.get('m_vecSectionAttributes',[]) or []:
                if at.get('m_strLocString'):
                    txt=clean(L(at['m_strLocString'],''),P)
                    if txt: sec.setdefault('tx',[]).append(txt)
                for key in ('m_vecElevatedAbilityProperties','m_vecImportantAbilityProperties','m_vecAbilityProperties'):
                    for p in at.get(key,[]) or []:
                        if isinstance(p,dict): p=p.get('m_strImportantProperty')
                        if p in P and not any(x['k']==p for x in sec['p']):
                            d=prop(iid,p,P[p])
                            if key!='m_vecAbilityProperties': d['e']=1
                            sec['p'].append(d)
            secs.append(sec)
        it['x']=secs
        cd=num(P.get('AbilityCooldown',{}).get('m_strValue'))
        if cd: it['cd']=cd
        items.append(it)

    ids={i['id'] for i in items}
    for i in items:
        if 'cp' in i: i['cp']=[c for c in i['cp'] if c in ids]

    heroes=[]
    base=resolve(h,'hero_base')
    def statmap(d): return {k[1:]:v for k,v in d.items() if isinstance(v,(int,float))}
    for hid,v in h.items():
        if not isinstance(v,dict) or not v.get('m_bPlayerSelectable') or v.get('m_bDisabled') or v.get('m_bInDevelopment') or v.get('m_bPrereleaseOnly'): continue
        r=resolve(h,hid)
        ab=r['m_mapBoundAbilities']
        w=resolve(a,ab['ESlot_Weapon_Primary']); wi=w.get('m_WeaponInfo',{})
        wprops=w.get('m_mapAbilityProperties',{})
        lv=r['m_mapLevelInfo']
        levels=[]
        for n in sorted(lv,key=int):
            e=lv[n]; bc=e.get('m_mapBonusCurrencies',{})
            levels.append([e.get('m_unRequiredGold',0),1 if e.get('m_bUseStandardUpgrade') else 0,bc.get('EAbilityPoints',0),bc.get('EAbilityUnlocks',0)])
        abil=[]
        for slot in ('ESlot_Signature_1','ESlot_Signature_2','ESlot_Signature_3','ESlot_Signature_4'):
            aid=ab.get(slot)
            if not aid or aid not in a: continue
            x=resolve(a,aid); P=x.get('m_mapAbilityProperties',{})
            shown=[]
            td=x.get('m_AbilityTooltipDetails',{}) or {}
            for sec in td.get('m_vecAbilityInfoSections',[]) or []:
                for blk in sec.get('m_vecAbilityPropertiesBlock',[]) or []:
                    for pr in blk.get('m_vecAbilityProperties',[]) or []:
                        p=pr.get('m_strImportantProperty') if isinstance(pr,dict) else pr
                        if p and p not in shown: shown.append(p)
                for p in sec.get('m_vecBasicProperties',[]) or []:
                    if p not in shown: shown.append(p)
            for p in ('AbilityCooldown','AbilityCharges','AbilityCooldownBetweenCharge','AbilityDuration','AbilityCastRange','Radius','AbilityChannelTime'):
                if p in P and num(P[p].get('m_strValue')) not in (None,0,-1) and p not in shown: shown.append(p)
            props=[prop(aid,p,P[p]) for p in shown if p in P]
            desc=' '.join(clean(L(sec.get('m_strLocString','')[1:],'') ,P) for sec in td.get('m_vecAbilityInfoSections',[]) if sec.get('m_strLocString')) or clean(L(aid+'_desc',''),P)
            ups=[]
            for i,u in enumerate(x.get('m_vecAbilityUpgrades',[]) or []):
                bon={}; sca={}
                for pu in u.get('m_vecPropertyUpgrades',[]) or []:
                    pl={kk.lower():vv for kk,vv in pu.items()}
                    pn=pl.get('m_strpropertyname'); val=num(pl.get('m_strbonus'))
                    if not pn or val is None: continue
                    ut=pl.get('m_eupgradetype','')
                    if 'Scale' in str(ut): sca[pn]=val
                    else: bon[pn]=val
                fake={k:{'m_strValue':abs(val) if val is not None else 0} for k,val in bon.items()}
                PP=dict(P); PP.update(fake)
                txt=clean(L(f'{aid}_t{i+1}_desc',''),PP)
                bl={}
                for k in list(bon)+list(sca):
                    if k in P:
                        d=prop(aid,k,P[k]); bl[k]=[d['l'],d['u']]
                    else: bl[k]=[plabel(aid,k),'']
                ups.append({'d':txt,'b':bon,'bl':bl,**({'s':sca} if sca else {})})
            abil.append({'id':aid,'n':L(aid,aid),'q':clean(L(aid+'_quip','')),'d':desc,'p':props,'u':ups,
                         'ult':1 if slot.endswith('4') else 0})
        st=statmap(r['m_mapStartingStats'])
        lu={k.replace('MODIFIER_VALUE_',''):v for k,v in r['m_mapStandardLevelUpUpgrades'].items() if v}
        heroes.append({'id':hid,'n':L(hid,hid),'col':r.get('m_colorUI'),'type':str(r.get('m_eHeroType','')).replace('ECitadelHeroType_',''),
            'tags':[L(t[1:],'') for t in r.get('m_vecHeroTags',[])],'role':L(hid+'_role',''),'play':L(hid+'_playstyle',''),'cx':r.get('m_nComplexity'),
            'st':st,'lu':lu,'lv':levels,
            'w':{'n':L(ab['ESlot_Weapon_Primary'],'') ,'dmg':wi.get('m_flBulletDamage'),'pel':wi.get('m_iBullets',1),'cyc':wi.get('m_flCycleTime'),'clip':wi.get('m_iClipSize'),
                 'rl':wi.get('m_reloadDuration'),'burst':wi.get('m_iBurstShotCount',1),'bcd':wi.get('m_flBurstShotCooldown',0),'fs':wi.get('m_flDamageFalloffStartRange'),'fe':wi.get('m_flDamageFalloffEndRange'),
                 'bs':wi.get('m_flBulletSpeed'),'crit':wi.get('m_flCritBonusStart'),'rs':1 if wi.get('m_bReloadSingleBullets') else 0,'ibc':wi.get('m_flIntraBurstCycleTime',0)},
            'ab':abil,'inv':{SLOT[k]:[[t['nGoldThreshold'],t['flBonus']] for t in vv] for k,vv in r['m_MapModCostBonuses'].items()},
            'slots':r.get('m_mapItemSlotInfo')})
    heroes.sort(key=lambda x:x['n'])

    for x in heroes:
        r = resolve(h, x['id'])
        x['im'] = [cdn(r.get('m_strIconImageSmall', '')), cdn(r.get('m_strIconHeroCard', ''))]
        x['im2'] = ['', '']
        for ab in x['ab']:
            ab['im'] = cdn(resolve(a, ab['id']).get('m_strAbilityImage', '')); ab['im2'] = ''
        x['st'] = {k: x['st'][k] for k in ('MaxMoveSpeed', 'SprintSpeed', 'LightMeleeDamage', 'HeavyMeleeDamage', 'MaxHealth', 'Stamina', 'BaseHealthRegen') if k in x['st']}
        x.pop('slots', None)
    for i in items:
        r = resolve(a, i['id'])
        i['im'] = cdn(r.get('m_strShopIconLarge') or r.get('m_strAbilityImage', '')); i['im2'] = ''
    return heroes, items

def main():
    offline = '--offline' in sys.argv
    old = {}
    try: old = json.load(open(os.path.join(DATA, 'gamedata.json'), encoding='utf-8'))
    except Exception: pass
    if offline:
        if not old: sys.exit('No data/gamedata.json to embed. Run without --offline first.')
        heroes, items = old['heroes'], old['items']
    else:
        heroes, items = extract()
        # keep previously known fallback image paths where ids still match
        oh = {x['id']: x for x in old.get('heroes', [])}; oi = {x['id']: x for x in old.get('items', [])}
        for x in heroes:
            if x['id'] in oh:
                x['im2'] = oh[x['id']].get('im2', ['', ''])
                oab = {b['id']: b for b in oh[x['id']].get('ab', [])}
                for ab in x['ab']: ab['im2'] = oab.get(ab['id'], {}).get('im2', '')
        for i in items:
            if i['id'] in oi: i['im2'] = oi[i['id']].get('im2', '')
        print(f'Extracted {len(heroes)} heroes and {len(items)} items.')
    try:
        tl = json.load(open(os.path.join(DATA, 'tracklock-snapshot.json'), encoding='utf-8'))
    except Exception:
        tl = old.get('tl', {})
    import datetime
    snap_path = os.path.join(DATA, 'tracklock-snapshot.json')
    tl_date = old.get('tlDate', '')
    if os.path.exists(snap_path):
        tl_date = datetime.date.fromtimestamp(os.path.getmtime(snap_path)).strftime('%b %d, %Y').replace(' 0', ' ')
    ids = {i['id'] for i in items}
    for t in tl.values():
        for k in t.get('p', {}): t['p'][k] = [x for x in t['p'][k] if x[0] in ids]
    D = {'heroes': heroes, 'items': items, 'tl': tl, 'tlDate': tl_date}
    json.dump(D, open(os.path.join(DATA, 'gamedata.json'), 'w', encoding='utf-8'), separators=(',', ':'))
    lookup = {'heroes': {x['id']: {'name': x['n'], 'slug': slug(x['n']), 'abilities': [b['n'] for b in x['ab']]} for x in heroes},
              'items': {i['n']: i['id'] for i in items}}
    json.dump(lookup, open(os.path.join(DATA, 'lookup.json'), 'w', encoding='utf-8'), indent=1)
    tpl = open(os.path.join(ROOT, 'src', 'app.template.html'), encoding='utf-8').read()
    out = tpl.replace('__DATA__', json.dumps(D, separators=(',', ':')).replace('</', '<\\/'))
    os.makedirs(os.path.join(ROOT, 'public'), exist_ok=True)
    open(os.path.join(ROOT, 'public', 'index.html'), 'w', encoding='utf-8').write(out)
    print('Wrote public/index.html, data/gamedata.json and data/lookup.json. Restart the server to pick up the new lookup.')

if __name__ == '__main__':
    main()
