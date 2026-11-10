// 小蓝鱼的屋后菜园。纯表现层：种植规则和持久化由 garden-state / API 管理。
import * as THREE from './vendor/three.module.js';

export const GARDEN_PLOTS = Object.freeze(Array.from({ length: 8 }, (_, id) => Object.freeze({
  id, x: [2, 4.7, 7.4, 10.1][id % 4], z: id < 4 ? -2.2 : -5,
  width: 2.05, depth: 1.65
})));

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const CROP_LABELS = {radish:'小萝卜',carrot:'胡萝卜',lettuce:'生菜',tomato:'番茄',cucumber:'黄瓜',eggplant:'茄子',pepper:'甜椒',pumpkin:'南瓜',corn:'玉米',strawberry:'草莓',potato:'土豆',cabbage:'卷心菜'};

export function createGardenWorld(world, renderer, { quality = 'balanced' } = {}) {
  const group = new THREE.Group(); group.name = 'feiyu-kitchen-garden';
  world.scene.add(group);
  const ownMaterials = new Set(); const ownTextures = new Set(); const geometries = new Map();
  const material = (color, roughness = .85, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({color, roughness, ...extra}); ownMaterials.add(m); return m;
  };
  const M = {
    timber: world.mats.oak, endgrain: world.mats.oakLight, darkwood: world.mats.walnut,
    hardware: world.mats.brass, iron: world.mats.dark, ceramic: world.mats.ceramic,
    soil: material(0x61432d, 1), earth: material(0x75503a, 1), clod: material(0x866044, 1),
    grass: material(0x8f9d6a, 1), grassDark: material(0x6d8151, 1), gravel: material(0xb5ab8f, 1),
    stone: material(0xd0c4a6, .95), stone2: material(0xbdb49e, .98),
    stem: material(0x5e8237), leaf: material(0x588b40), leafLight: material(0x80a84d), leafDark: material(0x386840),
    red: material(0xc84b3e, .4), pink: material(0xbf4d66, .5), orange: material(0xe0943d, .55),
    yellow: material(0xe0bd57, .5), purple: material(0x624065, .38), greenFruit: material(0x62884b, .5),
    cucumber: material(0x3e7345, .5), white: material(0xf2e6c9, .55), potato: material(0xb69762, .9),
    terracotta: world.mats.terracotta, teal: material(0x5e8882, .6), brass: world.mats.brass,
    seed: material(0xd2bc86), roof: material(0x516a65, .8), cream: material(0xe9dfc6),
    water: material(0x567e86, .18, {metalness:.25}), selected: material(0xffda7d, .65, {emissive:0x9d6b23,emissiveIntensity:.15})
  };
  // All geometry and materials are shared. Each build is batched into instances,
  // keeping hundreds of individual leaves/boards out of the draw-call count.
  function geometry(kind) {
    if (geometries.has(kind)) return geometries.get(kind);
    let g;
    if (kind === 'box') g = new THREE.BoxGeometry(1,1,1);
    else if (kind === 'ball') g = new THREE.SphereGeometry(1,quality === 'low' ? 8 : 12,quality === 'low' ? 6 : 8);
    else if (kind === 'cyl') g = new THREE.CylinderGeometry(1,1,1,12);
    else if (kind === 'cone') g = new THREE.CylinderGeometry(1,.04,1,12);
    else if (kind === 'pot') g = new THREE.CylinderGeometry(1,.82,1,12);
    else if (kind === 'ring') g = new THREE.TorusGeometry(1,.045,5,20);
    else if (kind === 'leaf') {
      const s = new THREE.Shape();
      s.moveTo(0,0); s.bezierCurveTo(-.5,.22,-.48,.64,0,1);
      s.bezierCurveTo(.48,.64,.5,.22,0,0);
      g = new THREE.ExtrudeGeometry(s,{depth:.025,bevelEnabled:false,curveSegments:5});
      const a=g.attributes.position;
      for(let i=0;i<a.count;i++) {const x=a.getX(i),y=a.getY(i);a.setZ(i,a.getZ(i)+Math.sin(y*Math.PI)*.12+Math.abs(x)*.16);}
      g.computeVertexNormals();
    } else {
      // Unit chamfered block, a softer edge for stone slabs and cabinet tops.
      const s=new THREE.Shape();s.moveTo(-.44,-.48);s.lineTo(.44,-.48);s.quadraticCurveTo(.48,-.48,.48,-.44);
      s.lineTo(.48,.44);s.quadraticCurveTo(.48,.48,.44,.48);s.lineTo(-.44,.48);s.quadraticCurveTo(-.48,.48,-.48,.44);
      s.lineTo(-.48,-.44);s.quadraticCurveTo(-.48,-.48,-.44,-.48);
      g=new THREE.ExtrudeGeometry(s,{depth:.96,bevelEnabled:true,bevelSize:.02,bevelThickness:.02,bevelSegments:1,steps:1,curveSegments:3});g.translate(0,0,-.48);
    }
    geometries.set(kind,g);return g;
  }
  function batch(parent) {
    const items=new Map();const transform=new THREE.Object3D();
    const put=(kind,m,x,y,z,sx=1,sy=1,sz=1,rx=0,ry=0,rz=0)=>{
      const key=kind+':'+m.uuid;
      if(!items.has(key))items.set(key,{kind,m,transforms:[]});
      transform.position.set(x,y,z);transform.scale.set(sx,sy,sz);transform.rotation.set(rx,ry,rz);transform.updateMatrix();
      items.get(key).transforms.push(transform.matrix.clone());
    };
    const rod=(m,a,b,r=.02)=>{
      const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),dir=bv.clone().sub(av);
      transform.position.copy(av.add(bv).multiplyScalar(.5));transform.scale.set(r,dir.length(),r);transform.quaternion.setFromUnitVectors(UP,dir.normalize());transform.updateMatrix();
      const key='cyl:'+m.uuid;if(!items.has(key))items.set(key,{kind:'cyl',m,transforms:[]});items.get(key).transforms.push(transform.matrix.clone());
    };
    return {put,rod,flush(){
      for(const {kind,m,transforms} of items.values()) {
        const mesh=new THREE.InstancedMesh(geometry(kind),m,transforms.length);mesh.name='garden-'+kind;
        transforms.forEach((matrix,i)=>mesh.setMatrixAt(i,matrix));mesh.instanceMatrix.needsUpdate=true;
        mesh.castShadow=true;mesh.receiveShadow=true;mesh.computeBoundingSphere();parent.add(mesh);
      }
    }};
  }
  function label(text,w,h,bg='#e9dfc5',fg='#385344') {
    const c=document.createElement('canvas');c.width=512;c.height=128;
    const ctx=c.getContext('2d');ctx.fillStyle=bg;ctx.fillRect(0,0,512,128);
    ctx.strokeStyle=fg;ctx.lineWidth=3;ctx.strokeRect(9,9,494,110);
    ctx.fillStyle=fg;ctx.font='bold 50px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,256,66,470);
    const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;ownTextures.add(tex);
    const m=material(0xffffff,.8,{map:tex});
    const mesh=new THREE.Mesh(geometry('box'),m); // replaced with a dedicated sign plane for undistorted text
    const plane=new THREE.PlaneGeometry(w,h);geometries.set('label-'+tex.uuid,plane);mesh.geometry=plane;
    return {mesh,tex,ctx};
  }
  const staticParts=new THREE.Group();staticParts.name='garden-structures';group.add(staticParts);
  const B=batch(staticParts);const P=B.put;
  P('bevel',M.grass,6.6,-.025,-3.85,12.9,.075,7.5);
  P('box',M.earth,6.6,-.085,-3.85,12.8,.05,7.4);
  // Crushed gravel main walk and fitted individual sandstone stepping stones.
  P('bevel',M.gravel,6.55,.018,-3.6,12.25,.022,.82);
  P('bevel',M.gravel,6.55,.018,-.65,12.2,.022,.65);
  P('bevel',M.gravel,6.55,.018,-6.35,12.2,.022,.62);
  for(const x of [.72,3.35,6.05,8.75,11.42])P('bevel',M.gravel,x,.018,-3.4,.48,.022,5.8);
  for(let i=0;i<20;i++)P('bevel',i%3?M.stone:M.stone2,.73+i*.62,.035,-3.6,.56,.035,.57,0,(i%3-1)*.028,0);
  for(const x of [3.35,6.05,8.75,11.42])for(let j=0;j<8;j++)P('bevel',j%3?M.stone:M.stone2,x,.034,-.72-j*.75,.36,.032,.55,0,(j%3-1)*.04,0);
  // A continuous side path joins the existing west foyer door to the back gate.
  // Its centre stays outside the house wall, then meets the middle garden aisle.
  P('bevel',M.gravel,-.65,.016,1.32,.81,.027,10.7);
  P('bevel',M.gravel,-.05,.018,-3.6,1.75,.027,.9);
  P('bevel',M.gravel,-.12,.018,6.25,1.55,.027,.82);
  for(let i=0;i<17;i++)P('bevel',i%3?M.stone:M.stone2,-.65,.035,6.25-i*.6,.57,.035,.52,0,(i%3-1)*.035,0);
  for(const x of [-.55,.05,.65])P('bevel',M.stone,x,.035,-3.6,.55,.035,.58);
  // Low cottage fence. A gate on the west connects to the existing side yard.
  for(let i=0;i<25;i++) {
    const x=.4+i*.52;P('bevel',M.cream,x,.52,-7.42,.11,1.02,.09);
    P('cone',M.cream,x,1.07,-7.42,.072,.12,.072);
  }
  for(const y of [.3,.76])P('box',M.endgrain,6.65,y,-7.4,12.65,.07,.075);
  for(const x of [.33,12.98]) {
    for(let i=0;i<12;i++) {
      const z=-.6-i*.56;
      if(x<1&&z>-4.24&&z<-2.96)continue;
      P('bevel',M.cream,x,.47,z,.09,.94,.11);
    }
    for(const y of [.28,.7]) {
      if(x<1) {
        P('box',M.endgrain,x,y,-5.78,.075,.07,3.08);
        P('box',M.endgrain,x,y,-1.76,.075,.07,2.4);
      } else P('box',M.endgrain,x,y,-3.94,.075,.07,6.75);
    }
  }
  // Gate leaves are folded back alongside the fence; the full aisle stays clear.
  for(const z of [-4.24,-2.96]) {
    P('bevel',M.darkwood,.33,.56,z,.15,1.12,.15);
    P('bevel',M.endgrain,.33,1.13,z,.21,.075,.21);
    for(const y of [.26,.76])P('cyl',M.brass,.24,y,z,.026,.1,.026);
  }
  for(let i=0;i<4;i++)P('bevel',M.cream,.19,.49,-4.29-i*.15,.075,.87,.08);
  for(const y of [.23,.72])P('box',M.endgrain,.19,y,-4.53,.075,.065,.61);
  B.rod(M.endgrain,[.19,.25,-4.8],[.19,.72,-4.27],.028);
  // Trellised name board at the back, turned to the north viewing direction.
  for(const x of [5.3,7.05]) {
    P('bevel',M.darkwood,x,1.05,-7.07,.085,2.1,.085);
    P('bevel',M.endgrain,x,2.13,-7.07,.16,.08,.16);
  }
  P('bevel',M.endgrain,6.175,1.82,-7.07,1.98,.45,.09);
  const title=label('小蓝鱼的小菜园',1.81,.35);title.mesh.position.set(6.175,1.82,-7.12);title.mesh.rotation.y=Math.PI;staticParts.add(title.mesh);
  for(const x of [5.3,7.05])for(let i=0;i<5;i++) {
    P('ball',i%2?M.leaf:M.leafLight,x+.06*Math.sin(i*2),.35+i*.3,-7.09,.12,.04,.075,0,i,.2);
  }
  // Open potting shelter: bevelled bench, lower shelf, seed drawers, tool hooks.
  const bx=2.0,bz=-6.85;
  for(const dx of [-.83,.83])for(const dz of [-.26,.26])P('bevel',M.darkwood,bx+dx,.43,bz+dz,.065,.84,.065);
  P('bevel',M.timber,bx,.88,bz,1.95,.09,.76);P('bevel',M.endgrain,bx,.32,bz,1.8,.045,.65);
  for(const dx of [-.88,.88])P('box',M.darkwood,bx+dx,1.45,bz-.31,.07,1.35,.07);
  P('bevel',M.roof,bx,2.15,bz,2.15,.085,1.0,-.14);
  for(let i=0;i<8;i++)P('box',M.darkwood,bx-.83+i*.235,1.45,bz-.32,.12,.9,.045);
  P('bevel',M.endgrain,bx,.74,bz+.34,1.75,.16,.04);
  for(const dx of [-.57,0,.57]) {P('bevel',M.cream,bx+dx,.74,bz+.37,.53,.135,.025);P('ball',M.brass,bx+dx,.74,bz+.396,.017,.017,.012);}
  for(let i=0;i<3;i++) {
    const x=bx-.6+i*.28;P('pot',M.terracotta,x,1.0,bz+.02,.105,.18,.105);P('ring',M.terracotta,x,1.09,bz+.02,.087,.087,.087,Math.PI/2);
    P('cyl',M.soil,x,1.085,bz+.02,.075,.01,.075);
  }
  // Hanging fork and spade, articulated handles and visible steel tool heads.
  for(const x of [2.36,2.68]) {
    B.rod(M.endgrain,[x,1.09,bz-.265],[x,1.76,bz-.265],.018);
    P('ring',M.iron,x,1.8,bz-.265,.065,.085,.065);
  }
  P('bevel',M.iron,2.36,1.04,bz-.265,.13,.16,.035);
  P('box',M.iron,2.68,1.06,bz-.265,.15,.04,.035);
  for(let i=0;i<4;i++)P('box',M.iron,2.62+i*.04,.99,bz-.265,.013,.13,.022);
  // Slatted harvest crates below the bench, with inset dark voids.
  function crate(x,y,z,w=.56,d=.43) {
    P('box',M.darkwood,x,y+.04,z,w,.04,d);
    for(const yy of [.11,.22])for(const zz of [-d/2,d/2])P('box',M.endgrain,x,y+yy,z+zz,w,.08,.025);
    for(const yy of [.11,.22])for(const xx of [-w/2,w/2])P('box',M.timber,x+xx,y+yy,z,.025,.08,d);
    for(const xx of [-w/2+.025,w/2-.025])for(const zz of [-d/2+.025,d/2-.025])P('box',M.darkwood,x+xx,y+.15,z+zz,.04,.28,.04);
  }
  crate(1.52,.34,-6.84);crate(2.3,.34,-6.84);
  // Rain barrel with stave highlights, two hoops, lid, tap and watering can.
  const rx=12.05,rz=-2.0;
  P('cyl',M.teal,rx,.49,rz,.34,.88,.34);P('cyl',M.darkwood,rx,.055,rz,.35,.05,.35);
  for(const yy of [.23,.73])P('ring',M.iron,rx,yy,rz,.342,.342,.342,Math.PI/2);
  P('cyl',M.endgrain,rx,.95,rz,.35,.04,.35);
  P('bevel',M.darkwood,rx,.99,rz,.18,.04,.07);
  B.rod(M.brass,[rx-.32,.25,rz],[rx-.48,.25,rz],.025);B.rod(M.brass,[rx-.46,.25,rz],[rx-.46,.18,rz],.025);
  P('bevel',M.brass,rx-.39,.32,rz,.1,.018,.04);
  const wx=11.86,wz=-2.7;
  P('cyl',M.teal,wx,.24,wz,.18,.35,.18);P('cyl',M.water,wx,.42,wz,.145,.006,.145);
  P('ring',M.teal,wx+.13,.31,wz,.19,.22,.19,0,Math.PI/2);
  B.rod(M.teal,[wx-.1,.21,wz],[wx-.5,.43,wz],.04);
  P('cyl',M.brass,wx-.52,.455,wz,.07,.045,.07,0,0,-.9);
  // Slatted compost bin with green lid and rich contents, beside seed chest.
  for(let i=0;i<5;i++)for(const x of [11.57,12.43])P('box',M.darkwood,x,.15+i*.13,-5.35,.055,.1,.92);
  for(let i=0;i<5;i++)for(const z of [-5.81,-4.89])P('box',M.timber,12,.15+i*.13,z,.9,.1,.055);
  P('bevel',M.soil,12,.58,-5.35,.8,.06,.8);
  P('bevel',M.roof,12,.82,-5.5,.98,.05,.63,-.14);
  P('bevel',M.endgrain,12,1.01,-5.77,.88,.24,.055);
  const compost=label('堆 肥',.72,.18);compost.mesh.position.set(12,1.01,-5.805);compost.mesh.rotation.y=Math.PI;staticParts.add(compost.mesh);
  crate(11.95,0,-6.55,.85,.62);
  for(let i=0;i<3;i++)P('bevel',i%2?M.cream:M.teal,11.72+i*.24,.38,-6.55,.19,.3,.45,0,.04*(i-1),0);
  // A little harvest counter shares the potting row, leaving its walking aisle free.
  for(const x of [4.16,5.24])for(const z of [-7.18,-6.73])P('bevel',M.darkwood,x,.35,z,.06,.7,.06);
  P('bevel',M.timber,4.7,.73,-6.96,1.25,.075,.62);
  for(const yy of [.41,.55])P('box',M.endgrain,4.7,yy,-7.2,1.16,.1,.03);
  P('bevel',M.cream,4.7,.55,-6.64,.89,.24,.035);
  const produceSign=label('今 日 收 成',.76,.17);produceSign.mesh.position.set(4.7,.55,-6.615);staticParts.add(produceSign.mesh);
  P('pot',M.endgrain,4.47,.83,-6.94,.2,.16,.15);
  for(let i=0;i<4;i++){P('ball',i%2?M.orange:M.red,4.36+i*.065,.93,-6.94+(i%2)*.055,.058,.055,.058);P('ball',M.leaf,4.36+i*.065,.985,-6.94+(i%2)*.055,.027,.009,.021);}
  P('bevel',M.teal,5.05,.83,-6.95,.25,.12,.2);
  P('bevel',M.brass,5.05,.9,-6.95,.16,.015,.12);
  // Small fixed garden lanterns keep paths readable even while the house sleeps.
  const lanternGlow=material(0xffe2ac,.45,{emissive:0xffc976,emissiveIntensity:.8});
  for(const [x,z] of [[.56,-4.45],[12.55,-6.35]]) {
    P('bevel',M.darkwood,x,.64,z,.07,1.28,.07);
    P('bevel',M.iron,x,1.29,z,.24,.045,.24);
    P('bevel',lanternGlow,x,1.46,z,.15,.29,.15);
    for(const xx of [-.1,.1])for(const zz of [-.1,.1])P('box',M.iron,x+xx,1.46,z+zz,.022,.3,.022);
    P('cone',M.iron,x,1.67,z,.18,.13,.18,Math.PI);
    const light=new THREE.PointLight(0xffd396,3.2,7,2);light.position.set(x,1.48,z);group.add(light);
  }
  // Flower companions and border herbs: deliberately sparse around work routes.
  for(const [x,z] of [[.75,-6.85],[4.1,-6.94],[8.2,-6.94],[9.05,-6.94],[12.5,-.65]]) {
    P('pot',M.terracotta,x,.18,z,.21,.33,.21);P('cyl',M.soil,x,.35,z,.16,.015,.16);
    for(let i=0;i<5;i++) {
      const a=i*TAU/5,xx=x+Math.cos(a)*.13,zz=z+Math.sin(a)*.13;
      B.rod(M.stem,[x,.34,z],[xx,.65,zz],.012);
      P('ball',M.leaf,xx,.5,zz,.1,.025,.055,0,a,.4);
      for(let k=0;k<5;k++)P('ball',M.yellow,xx+Math.cos(k*TAU/5)*.035,.66,zz+Math.sin(k*TAU/5)*.035,.035,.018,.035);
      P('ball',M.orange,xx,.67,zz,.024,.018,.024);
    }
  }
  const plotObjects=[];const pickables=[];
  for(const plot of GARDEN_PLOTS) {
    const {id,x,z,width:w,depth:d}=plot;
    // Two visible courses of timber, end-grain posts and brass corner fixings.
    for(const y of [.11,.235]) {
      for(const zz of [-d/2,d/2])P('bevel',M.timber,x,y,z+zz,w,.115,.07);
      for(const xx of [-w/2,w/2])P('bevel',M.endgrain,x+xx,y,z,.07,.115,d);
    }
    for(const xx of [-w/2+.06,w/2-.06])for(const zz of [-d/2+.06,d/2-.06]) {
      P('bevel',M.darkwood,x+xx,.18,z+zz,.095,.36,.095);
      for(const y of [.1,.24])P('ball',M.hardware,x+xx,y,z+Math.sign(zz)*(d/2+.039),.014,.014,.008);
    }
    const soilMat=M.soil.clone();ownMaterials.add(soilMat);
    const soil=new THREE.Mesh(geometry('bevel'),soilMat);soil.position.set(x,.15,z);soil.scale.set(w-.13,.055,d-.13);soil.receiveShadow=true;group.add(soil);
    const hitMat=new THREE.MeshBasicMaterial({visible:false});ownMaterials.add(hitMat);
    const hit=new THREE.Mesh(geometry('box'),hitMat);hit.position.set(x,.29,z);hit.scale.set(w,.12,d);hit.userData.gardenPlot=id;hit.name='garden-plot-'+id;group.add(hit);pickables.push(hit);
    P('box',M.darkwood,x-.67,.36,z-d/2-.09,.035,.56,.035);
    P('bevel',M.endgrain,x-.67,.63,z-d/2-.09,.5,.22,.035,0,0,.035);
    const sign=label(String(id+1).padStart(2,'0')+' · 菜畦',.45,.17);sign.mesh.position.set(x-.67,.63,z-d/2-.112);sign.mesh.rotation.y=Math.PI;group.add(sign.mesh);
    const plants=new THREE.Group();plants.name='garden-crop-'+id;plants.position.set(x,.18,z);group.add(plants);
    const selection=new THREE.Group();selection.visible=false;group.add(selection);
    const S=batch(selection);
    for(const zz of [-d/2-.045,d/2+.045])S.put('bevel',M.selected,x,.32,z+zz,w+.15,.025,.025);
    for(const xx of [-w/2-.045,w/2+.045])S.put('bevel',M.selected,x+xx,.32,z,.025,.025,d+.15);
    S.flush();plotObjects.push({soil,plants,selection,sign,key:'',label:''});
  }
  B.flush();

  // Hand tools accompany only a confirmed work dwell. Movement and rewards are
  // controlled by the server; these lightweight props never change save data.
  const workRig=new THREE.Group();workRig.name='garden-character-tools';workRig.visible=false;group.add(workRig);
  const workTools=new Map();
  function makeTool(name,draw) {
    const tool=new THREE.Group();tool.name='garden-work-'+name;tool.visible=false;workRig.add(tool);
    const b=batch(tool);draw(b.put,b.rod);b.flush();workTools.set(name,tool);return tool;
  }
  const hoe=makeTool('till',(p,rod)=>{
    rod(M.endgrain,[.24,.3,-.43],[.24,1.31,.02],.024);
    p('ring',M.darkwood,.24,1.33,.03,.065,.09,.065,0,Math.PI/2);
    p('cyl',M.brass,.24,.35,-.41,.032,.14,.032,-.42);
    p('bevel',M.iron,.24,.24,-.52,.28,.04,.19,0,0,-.03);
    p('bevel',M.hardware,.24,.265,-.48,.09,.025,.05);
  });
  const can=makeTool('water',(p,rod)=>{
    p('pot',M.teal,.3,.68,-.16,.17,.29,.17);
    p('ring',M.teal,.3,.83,-.16,.165,.165,.165,Math.PI/2);
    p('cyl',M.water,.3,.82,-.16,.14,.008,.14);
    p('ring',M.iron,.44,.82,-.12,.13,.17,.13,0,Math.PI/2);
    rod(M.teal,[.3,.6,-.3],[.3,.74,-.66],.033);
    p('ball',M.teal,.3,.74,-.66,.052,.05,.045);
    p('cyl',M.brass,.3,.73,-.7,.065,.035,.065,Math.PI/2);
    for(let i=0;i<7;i++){const a=i*TAU/7;p('ball',M.iron,.3+Math.cos(a)*.038,.73+Math.sin(a)*.038,-.72,.006,.006,.004);}
    p('ring',M.brass,.3,.63,-.16,.168,.168,.168,Math.PI/2);
  });
  makeTool('plant',(p,rod)=>{
    p('bevel',M.cream,.29,.72,-.23,.19,.28,.055,0,0,.12);
    p('bevel',M.teal,.29,.75,-.265,.14,.1,.012,0,0,.12);
    p('ball',M.leafLight,.29,.75,-.278,.025,.045,.009,0,0,.5);
    p('box',M.endgrain,.29,.83,-.23,.19,.028,.057,0,0,.12);
    rod(M.iron,[.39,.42,-.4],[.39,.64,-.29],.015);
    p('bevel',M.iron,.39,.37,-.43,.08,.14,.025,-.35);
    p('bevel',M.endgrain,.39,.66,-.28,.045,.12,.045,-.35);
  });
  makeTool('fertilize',(p)=>{
    p('pot',M.iron,.3,.56,-.2,.145,.23,.145);
    p('cyl',M.earth,.3,.677,-.2,.137,.015,.137);
    p('ring',M.brass,.3,.68,-.2,.145,.145,.145,Math.PI/2);
    p('ring',M.iron,.3,.73,-.2,.145,.18,.145);
    for(let i=0;i<9;i++)p('ball',i%2?M.clod:M.leafDark,.3+Math.sin(i*2.4)*.095,.69,-.2+Math.cos(i*2.4)*.095,.024,.015,.022);
  });
  function carriedBasket(p,filled=true) {
    p('bevel',M.darkwood,.3,.42,-.26,.46,.045,.32);
    for(let i=0;i<4;i++){const yy=.47+i*.043;for(const zz of [-.42,-.1])p('bevel',i%2?M.endgrain:M.timber,.3,yy,zz,.47,.031,.026);for(const xx of [.065,.535])p('bevel',M.endgrain,xx,yy,-.26,.027,.031,.32);}
    for(const xx of [.085,.515])for(const zz of [-.4,-.12])p('box',M.darkwood,xx,.52,zz,.026,.22,.026);
    p('ring',M.endgrain,.3,.72,-.26,.22,.25,.13);
    if(filled)for(let i=0;i<5;i++){const x=.15+(i%3)*.14,z=-.34+Math.floor(i/3)*.15;p('ball',i%2?M.orange:M.red,x,.63,z,.069,.064,.069);p('ball',M.leaf,x,.69,z,.035,.012,.026,0,i,0);}
  }
  makeTool('harvest',p=>carriedBasket(p));
  makeTool('sell',p=>carriedBasket(p));
  makeTool('buySeed',(p)=>{
    carriedBasket(p,false);
    for(let i=0;i<3;i++){p('bevel',i%2?M.cream:M.teal,.15+i*.15,.64,-.26,.12,.2,.045,0,0,(i-1)*.08);p('ball',M.leafLight,.15+i*.15,.66,-.29,.022,.035,.008);}
  });
  makeTool('buyCompost',(p)=>{
    p('ball',M.cream,.3,.63,-.25,.22,.29,.16);
    p('ring',M.darkwood,.3,.87,-.25,.055,.025,.055,Math.PI/2);
    p('bevel',M.teal,.3,.66,-.405,.18,.14,.018);
    p('ball',M.leafLight,.3,.66,-.42,.04,.055,.008,0,0,.4);
  });
  const sprayMaterial=new THREE.MeshStandardMaterial({color:0x9fd9e5,roughness:.3,transparent:true,opacity:.85});ownMaterials.add(sprayMaterial);
  const sprinkle=new THREE.InstancedMesh(geometry('ball'),sprayMaterial,18);sprinkle.name='garden-work-sprinkle';sprinkle.visible=false;sprinkle.frustumCulled=false;workRig.add(sprinkle);
  // The room caches static shadows. Small moving hand tools do not stamp a
  // permanent shadow into that cache when the character changes jobs or leaves.
  workRig.traverse(node=>{if(node.isMesh)node.castShadow=false;});
  const sprinkleTransform=new THREE.Object3D();let currentWork=null;
  function updateCharacter(her,position,heading=0) {
    const work=her?.gardenWork;
    currentWork=work&&work.phase==='working'&&workTools.has(work.type)&&!her.walking&&!her.asleep&&her.kind==='garden_'+work.type?work:null;
    workRig.visible=!!currentWork;
    if(!currentWork)return;
    const x=Number(position?.x),z=Number(position?.z),y=Number(position?.y)||0;
    if(!Number.isFinite(x)||!Number.isFinite(z)){workRig.visible=false;currentWork=null;return;}
    // Home headings turn clockwise from north; Three's positive yaw turns the
    // local -Z tool front west, hence the sign reversal at this boundary.
    workRig.position.set(x,y,z);workRig.rotation.y=-(Number(heading)||0);
    for(const [name,tool] of workTools)tool.visible=name===currentWork.type;
  }
  function animateCharacter(now) {
    if(!currentWork||!workRig.visible)return;
    const t=now*.001,type=currentWork.type,tool=workTools.get(type);
    for(const other of workTools.values()){other.rotation.set(0,0,0);other.position.set(0,0,0);}
    if(type==='till')hoe.rotation.x=Math.sin(t*3.8)*.22;
    else if(type==='water'){can.rotation.x=-.13+Math.sin(t*2)*.045;can.rotation.z=Math.sin(t*.9)*.025;}
    else if(type==='plant'||type==='fertilize'){tool.position.z=-.055*(1+Math.sin(t*3));tool.rotation.x=Math.sin(t*3)*.07;}
    else {tool.position.y=Math.sin(t*2.2)*.018;tool.rotation.z=Math.sin(t*1.7)*.025;}
    sprinkle.visible=['water','plant','fertilize'].includes(type);
    if(sprinkle.visible){
      sprinkle.material.color.set(type==='water'?0x9fd9e5:type==='plant'?0xd2bc86:0x75503a);
      for(let i=0;i<18;i++){const phase=(t*(type==='water'?1.5:.8)+i/18)%1;const a=i*2.39996;const spread=type==='water'?.09:.15;
        sprinkleTransform.position.set(.3+Math.sin(a)*spread*phase,.7-phase*.5,-.7-phase*.4+Math.cos(a)*spread*phase);
        sprinkleTransform.scale.setScalar(type==='water'?.012:.016);sprinkleTransform.scale.y*=type==='water'?2:1;sprinkleTransform.updateMatrix();sprinkle.setMatrixAt(i,sprinkleTransform.matrix);
      }sprinkle.instanceMatrix.needsUpdate=true;
    }
  }

  function clearInstances(node) {
    for(const child of [...node.children]) {node.remove(child);if(child.isInstancedMesh)child.dispose();}
  }
  function drawCrop(plot,node) {
    const b=batch(node);const p=b.put;
    const seed=plot.id*43+9;let r=seed;const rand=()=>{r=(r*1664525+1013904223)>>>0;return r/4294967296;};
    if(!plot.tilled) {
      for(let i=0;i<14;i++) {
        const x=(rand()-.5)*1.8,z=(rand()-.5)*1.35;
        p('ball',M.clod,x,0,z,.06+rand()*.035,.025,.05);
        if(i%2===0)for(let j=0;j<3;j++)p('leaf',M.grassDark,x,.01,z,.08,.12,.08,-1.15,j*2.1,0);
      }
      b.flush();return;
    }
    for(let i=0;i<4;i++)p('bevel',M.earth,-.69+i*.46,.005,0,.13,.035,1.33);
    for(let i=0;i<14;i++)p('ball',M.clod,(rand()-.5)*1.8,.018,(rand()-.5)*1.35,.018,.012,.015);
    if(!plot.cropId){b.flush();return;}
    const mature=plot.mature||plot.stage===3;const stage=plot.stage||0;
    const tall=['tomato','cucumber','eggplant','pepper','corn'].includes(plot.cropId);
    const count=plot.cropId==='pumpkin'?2:tall?4:6;
    const coords=count===2?[[-.48,0],[.48,0]]:count===4?[[-.5,-.38],[.5,-.38],[-.5,.38],[.5,.38]]:[[-.62,-.37],[0,-.37],[.62,-.37],[-.62,.37],[0,.37],[.62,.37]];
    function leaf(x,y,z,len,width,a,lift=.4,light=false) {
      p('leaf',light?M.leafLight:M.leaf,x,y,z,width,len,len,-Math.PI/2+lift,a,0);
    }
    function crown(x,y,z,n,len,width) {
      for(let j=0;j<n;j++)leaf(x,y,z,len,width,j*TAU/n+.3,.35+(j%3)*.17,j%3===0);
    }
    for(let index=0;index<coords.length;index++) {
      const [x,z]=coords[index];
      if(stage===0) {
        p('ball',M.earth,x,.025,z,.11,.032,.085);p('ball',M.seed,x,.054,z,.022,.012,.015);continue;
      }
      if(stage===1) {
        b.rod(M.stem,[x,.01,z],[x,.11,z],.008);leaf(x,.09,z,.16,.13,.7,.45,true);leaf(x,.09,z,.14,.12,3.9,.5);continue;
      }
      const scale=mature?1:.72;
      if(plot.cropId==='radish') {
        p('ball',mature?M.pink:M.white,x,.06,z,.12*scale,.12*scale,.115*scale);
        p('cone',M.white,x,.006,z,.05,.17,.05);
        crown(x,.14,z,5,.31*scale,.14);
      } else if(plot.cropId==='carrot') {
        p('cone',M.orange,x,.025,z,.082*scale,.27*scale,.082*scale);
        for(let j=0;j<5;j++) {
          const a=j*TAU/5,xx=x+Math.cos(a)*.13,zz=z+Math.sin(a)*.13;
          b.rod(M.stem,[x,.11,z],[xx,.41*scale,zz],.006);
          for(let k=1;k<4;k++)leaf(x+(xx-x)*k/4,.1+k*.07*scale,z+(zz-z)*k/4,.12,.065,a+(k%2?1.1:-1.1),.6,k%2===0);
        }
      } else if(plot.cropId==='lettuce') {
        crown(x,.02,z,9,.39*scale,.31*scale);crown(x,.065,z,6,.27*scale,.24*scale);
        p('ball',M.leafLight,x,.13*scale,z,.1*scale,.13*scale,.1*scale);
      } else if(plot.cropId==='cabbage') {
        crown(x,.025,z,7,.35*scale,.34*scale);
        p('ball',M.leafLight,x,.17*scale,z,.2*scale,.19*scale,.2*scale);
        for(let j=0;j<4;j++)leaf(x,.13*scale,z,.25*scale,.24,j*TAU/4,1.05,true);
      } else if(plot.cropId==='pumpkin') {
        for(let j=0;j<3;j++) {
          const a=j*TAU/3;const xx=x+Math.cos(a)*.25,zz=z+Math.sin(a)*.31;
          b.rod(M.stem,[x,.03,z],[xx,.04,zz],.014);leaf(xx,.04,zz,.34,.32,a,.3,j%2===0);
        }
        const fx=x-.03,fz=z+.12,rr=.2*scale;
        for(let j=0;j<7;j++)p('ball',mature?M.orange:M.greenFruit,fx+Math.cos(j*TAU/7)*rr*.42,rr*.65,fz+Math.sin(j*TAU/7)*rr*.42,rr*.7,rr*.72,rr*.7);
        b.rod(M.darkwood,[fx,rr*1.3,fz],[fx+.025,rr*1.65,fz],.025);
      } else if(plot.cropId==='strawberry') {
        crown(x,.03,z,7,.26*scale,.23);crown(x,.11,z,4,.17,.15);
        for(let j=0;j<3;j++) {
          const a=j*TAU/3,xx=x+Math.cos(a)*.18,zz=z+Math.sin(a)*.18;
          b.rod(M.stem,[x,.1,z],[xx,.09,zz],.007);
          p('cone',mature?M.red:M.white,xx,.074,zz,.056,.11,.056);
          for(let k=0;k<3;k++)p('ball',M.seed,xx+Math.cos(k*TAU/3)*.046,.083,zz+Math.sin(k*TAU/3)*.046,.006,.009,.006);
          for(let k=0;k<3;k++)leaf(xx,.128,zz,.06,.035,k*TAU/3,.15);
        }
      } else if(plot.cropId==='potato') {
        b.rod(M.stem,[x,0,z],[x,.32*scale,z],.015);crown(x,.12,z,7,.28*scale,.18);crown(x,.27*scale,z,4,.18,.14);
        if(mature)for(let j=0;j<3;j++)p('ball',M.potato,x+Math.cos(j*2.1)*.12,.025,z+Math.sin(j*2.1)*.12,.075,.05,.052,0,j,.1);
        p('ball',M.white,x,.35*scale,z,.025,.02,.025);
      } else if(plot.cropId==='corn') {
        const h=1.23*scale;b.rod(M.stem,[x,0,z],[x,h,z],.025);
        for(let j=0;j<6;j++)leaf(x,.2+j*.13*scale,z,.47*scale,.11,j%2?Math.PI+.3:.3,.35+(j%2)*.15,j%3===0);
        for(const a of [-.7,2.1]) {
          const xx=x+Math.cos(a)*.09,zz=z+Math.sin(a)*.09;
          p('ball',mature?M.yellow:M.greenFruit,xx,h*.6,zz,.065,.17,.065,0,a,-.18);
          leaf(xx,h*.48,zz,.3,.12,a,1.16);
          if(mature)for(let k=0;k<4;k++)p('ring',M.orange,xx,h*.53+k*.045,zz,.064,.064,.064,Math.PI/2);
        }
        for(let j=0;j<4;j++)b.rod(M.yellow,[x,h-.08,z],[x+(j-1.5)*.045,h+.13-Math.abs(j-1.5)*.025,z+.015*(j%2)],.006);
      } else {
        const h=(plot.cropId==='cucumber'?1.15:.83)*scale;
        b.rod(M.stem,[x,.01,z],[x+.035,h,z],.019);
        if(['tomato','cucumber'].includes(plot.cropId)) {
          b.rod(M.endgrain,[x-.18,0,z+.07],[x,h+.12,z+.07],.016);
          b.rod(M.endgrain,[x+.18,0,z+.07],[x,h+.12,z+.07],.016);
          for(let j=1;j<4;j++)b.rod(M.endgrain,[x-.18+j*.035,j*(h/4),z+.07],[x+.18-j*.035,j*(h/4),z+.07],.01);
        }
        for(let j=0;j<5;j++) {
          const a=j*2.4;const yy=.2+j*(h-.25)/5,xx=x+Math.cos(a)*.17,zz=z+Math.sin(a)*.17;
          b.rod(M.stem,[x,yy-.04,z],[xx,yy,zz],.009);
          leaf(xx,yy,zz,plot.cropId==='cucumber'?.25:.26,plot.cropId==='eggplant'?.23:.2,a,.5,j%2===0);
          if(j>0&&j<4) {
            const fx=xx,fz=zz,fy=yy-.09;
            if(plot.cropId==='tomato') {
              p('ball',mature?M.red:M.greenFruit,fx,fy,fz,.092*scale,.085*scale,.092*scale);
              for(let k=0;k<3;k++)leaf(fx,fy+.08*scale,fz,.06,.035,k*TAU/3,.03);
            } else if(plot.cropId==='cucumber') {
              p('ball',M.cucumber,fx,fy-.06,fz,.052*scale,.17*scale,.052*scale,0,a,.12);
              if(quality!=='low')for(let k=0;k<3;k++)p('ball',M.leafLight,fx+.042,fy-.16+k*.07,fz,.006,.009,.006);
            } else if(plot.cropId==='eggplant') {
              p('ball',mature?M.purple:M.greenFruit,fx,fy-.03,fz,.072*scale,.14*scale,.07*scale,0,a,.18);
              p('cone',M.leafDark,fx,fy+.085,fz,.07,.06,.07);
            } else {
              const color=mature?(index%2?M.yellow:M.red):M.greenFruit;
              for(let k=0;k<3;k++)p('ball',color,fx+Math.cos(k*TAU/3)*.037,fy-.02,fz+Math.sin(k*TAU/3)*.037,.055*scale,.085*scale,.055*scale);
              b.rod(M.stem,[fx,fy+.06,fz],[fx+.015,fy+.12,fz],.01);
            }
          }
        }
      }
    }
    if(plot.fertilized)for(let i=0;i<10;i++)p('ball',M.seed,(rand()-.5)*1.8,.025,(rand()-.5)*1.3,.011,.008,.01);
    b.flush();
  }
  function update(view) {
    let changed=false;
    for(const plot of view?.plots||[]) {
      const item=plotObjects[plot.id];if(!item)continue;
      const key=[!!plot.tilled,plot.cropId||'',plot.stage||0,!!plot.mature,!!plot.fertilized].join(':');
      if(key!==item.key) {clearInstances(item.plants);drawCrop(plot,item.plants);item.key=key;changed=true;}
      const moisture=Math.max(0,Math.min(1,Number(plot.moisture)||0));
      item.soil.material.color.copy(new THREE.Color(0x75503a)).lerp(new THREE.Color(0x403425),moisture);
      const title=String(plot.id+1).padStart(2,'0')+' · '+(CROP_LABELS[plot.cropId]||'菜畦');
      const labelKey=title+':'+!!plot.mature;
      if(item.label!==labelKey) {
        const ctx=item.sign.ctx;ctx.fillStyle=plot.mature?'#e9d391':'#e9dfc5';ctx.fillRect(0,0,512,128);ctx.strokeStyle='#385344';ctx.lineWidth=3;ctx.strokeRect(9,9,494,110);
        ctx.fillStyle='#385344';ctx.font='bold 48px "Microsoft YaHei",sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(title,256,66,470);item.sign.tex.needsUpdate=true;item.label=labelKey;
      }
    }
    if(changed&&renderer?.shadowMap)renderer.shadowMap.needsUpdate=true;
  }
  function setSelected(id) {plotObjects.forEach((plot,index)=>plot.selection.visible=index===id);}
  function dispose() {
    group.traverse(node=>{if(node.isInstancedMesh)node.dispose();});world.scene.remove(group);
    for(const g of geometries.values())g.dispose();for(const m of ownMaterials)m.dispose();for(const t of ownTextures)t.dispose();
  }
  return {group,pickables,update,setSelected,updateCharacter,animateCharacter,dispose};
}
