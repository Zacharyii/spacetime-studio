import * as THREE from 'three';

export function createVolumeMaterial(
  fullTexture: THREE.Data3DTexture,
  subjectTexture: THREE.Data3DTexture,
  dimensions: THREE.Vector3,
  frameCount: number,
  opacity: number,
  revealSubject: boolean,
): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uVolume: { value: subjectTexture },
      uFullVolume: { value: fullTexture },
      uDimensions: { value: dimensions },
      uDepth: { value: frameCount },
      uOpacity: { value: opacity },
      uProgress: { value: 0 },
      uRevealSubject: { value: revealSubject },
      uCameraLocal: { value: new THREE.Vector3(0.5, 0.5, 2.0) },
      uSteps: { value: Math.max(192, frameCount) },
    },
    vertexShader: `
      precision highp float;
      in vec3 position;
      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;
      uniform vec3 uDimensions;
      out vec3 vPosition;
      void main() {
        vPosition = position / uDimensions + 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      precision highp sampler3D;
      in vec3 vPosition;
      out vec4 outColor;
      uniform sampler3D uVolume;
      uniform sampler3D uFullVolume;
      uniform vec3 uCameraLocal;
      uniform float uDepth;
      uniform float uOpacity;
      uniform float uProgress;
      uniform bool uRevealSubject;
      uniform int uSteps;

      vec3 linearToSRGB(vec3 value) {
        vec3 low = value * 12.92;
        vec3 high = 1.055 * pow(max(value, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
        return mix(high, low, lessThanEqual(value, vec3(0.0031308)));
      }

      vec3 frameUv(vec3 position) {
        // Texture layers are stored in chronological order, earliest at Z = 0.
        float index = clamp(floor(position.z * uDepth), 0.0, uDepth - 1.0);
        return vec3(position.x, 1.0 - position.y, (index + 0.5) / uDepth);
      }

      void main() {
        vec3 rayDirection = normalize(vPosition - uCameraLocal);
        vec3 directionSign = mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), rayDirection));
        vec3 safeDirection = directionSign * max(abs(rayDirection), vec3(0.00001));
        vec3 tBounds = mix((vec3(1.0) - vPosition) / safeDirection,
                           (vec3(0.0) - vPosition) / safeDirection,
                           lessThan(rayDirection, vec3(0.0)));
        float rayLength = min(min(tBounds.x, tBounds.y), tBounds.z);
        if (rayLength <= 0.0) discard;

        float cutDistance = (uProgress - vPosition.z) / safeDirection.z;
        vec3 cutPoint = vPosition + rayDirection * cutDistance;
        bool hitsCut = abs(rayDirection.z) > 0.00001
          && cutDistance >= -0.00001 && cutDistance <= rayLength + 0.00001
          && all(greaterThanEqual(cutPoint.xy, vec2(0.0)))
          && all(lessThanEqual(cutPoint.xy, vec2(1.0)));
        cutPoint.z = uProgress;
        vec4 accumulated = vec4(0.0);
        float stepLength = rayLength / float(uSteps);
        // Composite the full current frame at its actual depth, so rotation
        // preserves occlusion instead of painting a floating plane on top.
        for (int i = 0; i < uSteps; i++) {
          float distance = (float(i) + 0.5) * stepLength;
          if (hitsCut && cutDistance <= distance) {
            accumulated.rgb += texture(uFullVolume, frameUv(cutPoint)).rgb * (1.0 - accumulated.a);
            accumulated.a = 1.0;
            break;
          }
          vec3 positionInVolume = vPosition + rayDirection * distance;
          vec3 uv = frameUv(positionInVolume);
          vec4 voxel = uRevealSubject && positionInVolume.z < uProgress
            ? texture(uVolume, uv) : texture(uFullVolume, uv);
          float alpha = voxel.a * uOpacity * 0.08;
          accumulated.rgb += voxel.rgb * alpha * (1.0 - accumulated.a);
          accumulated.a += alpha * (1.0 - accumulated.a);
          if (accumulated.a > 0.985) break;
        }
        // The cut can fall between the last sample and the box's exit face.
        if (hitsCut && accumulated.a <= 0.985) {
          accumulated.rgb += texture(uFullVolume, frameUv(cutPoint)).rgb * (1.0 - accumulated.a);
          accumulated.a = 1.0;
        }
        vec3 color = accumulated.rgb / max(accumulated.a, 0.00001);
        outColor = vec4(linearToSRGB(color), accumulated.a);
      }
    `,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}
