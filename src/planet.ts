// A planet painted from noise. The CPU writes a height map (and where the
// cities are) once at startup; a shader turns height into ocean, shore, land,
// peaks and ice per pixel, so coastlines stay curved however close you get,
// lights it from the star, and shows the city lights only on the night side.
// Clouds are a separate, coarser layer. Nothing is fetched.
import * as THREE from 'three'
import { fbm, hash3, heightAt, smooth } from './noise'

// Shader defines every material here and in worlds.ts and App.tsx picks up
// at creation. The page lowers the octave count on phones before it builds
// anything; the fbm loops read it.
export const SHADER_DEFINES: { FBM_OCTAVES: number } = { FBM_OCTAVES: 5 }

export function makePlanet(seed = 3, W = 1024) {
  const H = W / 2
  const data = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - y / H) * Math.PI
    const cl = Math.cos(lat)
    for (let x = 0; x < W; x++) {
      const lon = (x / W) * Math.PI * 2
      const px = cl * Math.cos(lon)
      const py = Math.sin(lat)
      const pz = cl * Math.sin(lon)
      // A three.js sphere puts this pixel at (-px, py, pz); the ground
      // simulation samples the same function in that frame.
      const h = heightAt(-px, py, pz, seed)
      const detail = fbm(px * 9, py * 9, pz * 9, seed + 101, 3)
      const polar = smooth(0.88, 0.96, Math.abs(py) + (detail - 0.5) * 0.06)
      // City lights: clusters on land away from the poles, sparse elsewhere.
      let glow = 0
      if (h >= 0.52 && polar < 0.3) {
        const cities = fbm(px * 14, py * 14, pz * 14, seed + 7, 3)
        glow = smooth(0.56, 0.74, cities) * (hash3(x, y, 0, seed + 99) < 0.55 ? 1 : 0.2)
      }
      const o = ((H - 1 - y) * W + x) * 4 // DataTexture rows run bottom-up
      data[o] = Math.round(Math.min(1, Math.max(0, h)) * 255)
      data[o + 1] = Math.round(glow * 255)
      data[o + 2] = Math.round(detail * 255)
      data[o + 3] = 255
    }
  }
  const height = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType)
  height.magFilter = THREE.LinearFilter
  height.minFilter = THREE.LinearMipmapLinearFilter
  height.generateMipmaps = true
  height.wrapS = THREE.RepeatWrapping
  height.needsUpdate = true

  // Clouds, coarser and transparent where there is no cloud.
  const CW = W / 2
  const CH = W / 4
  const cl = document.createElement('canvas')
  cl.width = CW
  cl.height = CH
  const cg = cl.getContext('2d')!
  const ci = cg.createImageData(CW, CH)
  for (let y = 0; y < CH; y++) {
    const lat = (0.5 - y / CH) * Math.PI
    const c = Math.cos(lat)
    for (let x = 0; x < CW; x++) {
      const lon = (x / CW) * Math.PI * 2
      const n = fbm(c * Math.cos(lon) * 3.2 + 5, Math.sin(lat) * 3.2, c * Math.sin(lon) * 3.2, seed + 31, 4)
      const a = smooth(0.56, 0.76, n)
      const o = (y * CW + x) * 4
      ci.data[o] = ci.data[o + 1] = ci.data[o + 2] = 255
      ci.data[o + 3] = 255 * a * 0.9
    }
  }
  cg.putImageData(ci, 0, 0)
  const clouds = new THREE.CanvasTexture(cl)
  clouds.colorSpace = THREE.SRGBColorSpace
  clouds.wrapS = THREE.RepeatWrapping

  return { height, clouds }
}

// Ashima simplex noise, shared by the star and the planet shaders.
export const NOISE_GLSL = /* glsl */ `
#ifndef FBM_OCTAVES
#define FBM_OCTAVES 5
#endif
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){
  float f=0.0, a=0.5;
  for(int i=0;i<FBM_OCTAVES;i++){ f+=a*snoise(p); p=p*2.03+vec3(1.7); a*=0.5; }
  return f;
}`

export const PLANET_VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vWorldNormal; varying vec3 vObj;
void main(){
  vUv = uv;
  vObj = normalize(position);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

// The same ramp planet.ts used to paint, now per pixel on the interpolated
// height, with a little fine noise so a coastline wiggles when you are close.
export const PLANET_FRAG = /* glsl */ `
uniform sampler2D uData; uniform vec3 uSunDir; uniform vec3 uSun; uniform vec3 uAmbient;
uniform vec3 uDeep, uShallow, uShore, uLow, uHigh, uPeak, uIce, uCity;
varying vec2 vUv; varying vec3 vWorldNormal; varying vec3 vObj;
${NOISE_GLSL}
void main(){
  vec4 d = texture2D(uData, vUv);
  float fine = snoise(vObj * 24.0) * 0.012 + snoise(vObj * 90.0) * 0.004;
  float h = d.r + fine;
  float detail = d.b;
  vec3 col;
  if (h < 0.5) col = mix(uDeep, uShallow, smoothstep(0.3, 0.5, h));
  else if (h < 0.53) col = mix(uShore, uLow, smoothstep(0.5, 0.53, h));
  else {
    col = mix(uLow, uHigh, smoothstep(0.53, 0.66, h));
    col = mix(col, uPeak, smoothstep(0.66, 0.78, h + (detail - 0.5) * 0.1));
  }
  float polar = smoothstep(0.88, 0.96, abs(vObj.y) + (detail - 0.5) * 0.06);
  col = mix(col, uIce, polar);
  vec3 n = normalize(vWorldNormal);
  float day = dot(n, uSunDir);
  vec3 lit = col * (max(day, 0.0) * uSun + uAmbient);
  float night = smoothstep(0.12, -0.2, day);
  gl_FragColor = vec4(lit + uCity * d.g * night * 1.5, 1.0);
}`

export const ATMOSPHERE_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec3 vNormal; varying vec3 vView;
void main(){
  float rim = 1.0 - max(dot(vNormal, vView), 0.0);
  float a = pow(rim, 3.2);
  gl_FragColor = vec4(uColor * 1.3, a * 0.9);
}`

export const ATMOSPHERE_VERT = /* glsl */ `
varying vec3 vNormal; varying vec3 vView;
void main(){
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`
