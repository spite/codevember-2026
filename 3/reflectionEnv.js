import { Mesh, PMREMGenerator, Scene, ShaderMaterial, SphereGeometry, BackSide, Vector2, Vector3, Color } from "three";

// Analytic studio for reflections only: floor graded into the wall through the horizon, a key softbox,
// a rim strip behind the subject and dark flags at the sides that give metal its edges. Optional tall strip lights
// at the sides draw an edge highlight down every run, and optional cards near the camera catch every bump on black.
const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 keyDir;
uniform vec2 keySize;
uniform float keyL;
uniform vec3 rimDir;
uniform vec2 rimSize;
uniform float rimL;
uniform vec2 flagSize;
uniform float floorL;
uniform float horizonL;
uniform float wallL;
uniform float ceilingL;
uniform float flagL;
uniform float stripL;
uniform vec2 stripSize;
uniform vec3 tint;
uniform vec3 cardDir[3];
uniform vec3 cardSize[3];
varying vec3 vDir;

// Feathered rounded rectangle centred on c, sized in tangent units.
float panel(vec3 d, vec3 c, vec2 size, float hot) {
  float k = dot(d, c);
  if (k <= 0.0) return 0.0;
  vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), c));
  vec3 b = cross(c, t);
  vec2 uv = vec2(dot(d, t), dot(d, b)) / (k * size);
  float r = pow(pow(abs(uv.x), 4.0) + pow(abs(uv.y), 4.0), 0.25);
  return (1.0 + hot - 2.0 * hot * r * r) * (1.0 - smoothstep(0.8, 1.0, r));
}

void main() {
  vec3 d = normalize(vDir);
  float L = d.y < 0.0
    ? mix(horizonL, floorL, smoothstep(0.0, 0.3, -d.y))
    : mix(horizonL, mix(wallL, ceilingL, smoothstep(0.3, 0.95, d.y)), smoothstep(0.0, 0.3, d.y));
  float flag = max(panel(d, normalize(vec3(1.0, 0.2, -0.15)), flagSize, 0.0), panel(d, normalize(vec3(-1.0, 0.2, -0.35)), flagSize, 0.0));
  L = mix(L, flagL, clamp(flag, 0.0, 1.0));
  L += keyL * panel(d, keyDir, keySize, 0.15);
  L += rimL * panel(d, rimDir, rimSize, 0.1);
  L += stripL * (panel(d, normalize(vec3(1.0, 0.15, 0.35)), stripSize, 0.1) + panel(d, normalize(vec3(-1.0, 0.15, 0.25)), stripSize, 0.1));
  for (int i = 0; i < 3; i++) L += cardSize[i].z * panel(d, cardDir[i], cardSize[i].xy, 0.1);
  gl_FragColor = vec4(tint * L, 1.0);
}
`;

export function bakeReflectionEnv(
  renderer,
  {
    keyDirection,
    keyIntensity = 20,
    keySize = new Vector2(0.43, 0.54),
    rimDirection = new Vector3(0.5, 0.3, -1),
    rimIntensity = 4,
    rimSize = new Vector2(0.12, 0.7),
    flagSize = new Vector2(0.45, 0.6),
    floor = 0.6,
    horizon = 0.45,
    wall = 0.35,
    ceiling = 0.05,
    flag = 0.01,
    strip = 0,
    stripSize = new Vector2(0.14, 1.1),
    tint = 0xfffaf3,
    cards = [],
    size = 512,
  },
) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: BackSide,
    depthWrite: false,
    uniforms: {
      keyDir: { value: keyDirection.clone().normalize() },
      keySize: { value: keySize },
      keyL: { value: keyIntensity },
      rimDir: { value: rimDirection.clone().normalize() },
      rimSize: { value: rimSize },
      rimL: { value: rimIntensity },
      flagSize: { value: flagSize },
      floorL: { value: floor },
      horizonL: { value: horizon },
      wallL: { value: wall },
      ceilingL: { value: ceiling },
      flagL: { value: flag },
      stripL: { value: strip },
      stripSize: { value: stripSize },
      tint: { value: new Color(tint) },
      cardDir: { value: [0, 1, 2].map((i) => (cards[i]?.direction ?? new Vector3(0, 0, 1)).clone().normalize()) },
      cardSize: { value: [0, 1, 2].map((i) => (cards[i] ? new Vector3(cards[i].size.x, cards[i].size.y, cards[i].intensity) : new Vector3(1, 1, 0))) },
    },
  });
  const scene = new Scene();
  const mesh = new Mesh(new SphereGeometry(10, 128, 64), material);
  scene.add(mesh);
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, 100, { size });
  pmrem.dispose();
  mesh.geometry.dispose();
  material.dispose();
  return { envMap: target.texture, maxLod: Math.max(target.texture.mipmaps.length - 1, 0) };
}
