// Geographic <-> GCJ-02 display coordinates. The conventional offset equations
// are also documented by https://github.com/wandergis/coordtransform (MIT).
// CGCS2000 is treated as geographic coordinates at POI/display precision;
// this is not a survey-grade datum transformation.
function offset({lon,lat}) {
  if(lon<=73.66||lon>=135.05||lat<=3.86||lat>=53.55)return {lon:0,lat:0};
  const x=lon-105,y=lat-35,pi=Math.PI;
  const wave=(v,a,b,c,d)=>(a*Math.sin(v*pi/b)+c*Math.sin(v*pi/d))*2/3;
  const common=wave(x,20,1/6,20,1/2);
  const north=-100+2*x+3*y+0.2*y*y+0.1*x*y+0.2*Math.sqrt(Math.abs(x))+common+wave(y,20,1,40,3)+wave(y,160,12,320,30);
  const east=300+x+2*y+0.1*x*x+0.1*x*y+0.1*Math.sqrt(Math.abs(x))+common+wave(x,20,1,40,3)+wave(x,150,12,300,30);
  const radians=lat*pi/180,eccentricity=0.00669342162296594323,axis=6378245;
  const magic=1-eccentricity*Math.sin(radians)**2,root=Math.sqrt(magic);
  return {lon:east*180/(axis/root*Math.cos(radians)*pi),lat:north*180/(axis*(1-eccentricity)/(magic*root)*pi)};
}
export function wgs84ToGcj02(point) {
  const delta=offset(point);return {lon:point.lon+delta.lon,lat:point.lat+delta.lat};
}
export function gcj02ToWgs84(point) {
  let raw={lon:point.lon,lat:point.lat};
  for(let i=0;i<6;i++){const projected=wgs84ToGcj02(raw);raw={lon:raw.lon+point.lon-projected.lon,lat:raw.lat+point.lat-projected.lat};}
  return raw;
}
export function straightDistance(a,b) {
  const rad=v=>v*Math.PI/180,dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon);
  const h=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;
  return Math.round(6371008.8*2*Math.asin(Math.sqrt(Math.min(1,h))));
}
