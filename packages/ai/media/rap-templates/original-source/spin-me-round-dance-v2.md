# Seedance 2.0｜Spin Me Round / Chipmunks Dance 动作模板 V2

基于本次上传的 tk1.mp4、tk2.mp4、tk3.mp4 按约0.5秒间隔抽帧检查后编排。三条原片分别约25.6、25.1、24.1秒；以下是压缩改编，不是逐秒还原，也尚未在用户的Seedance接入端实测。

## 直接使用

选择多图参考／全能参考模式，不选首尾帧模式。

- Image 1：内置无人场景图，建议明亮普通室内。
- Image 2：用户第一张照片，人物A。
- Image 3：用户第二张照片，人物B（双人／三人版）。
- Image 4：用户第三张照片，人物C（三人版）。

每张用户照片选一个明确人物。图片编号对应实际提交顺序；支持素材引用控件的界面应绑定对应素材。输出9:16；单人和双人12秒，三人15秒。音乐使用自有原创母带后期合成。下面的 Avoid 已放在主提示词内，不要求接口提供 negative_prompt 字段。时间段仅为大致编排，优先保持动作顺序。

## 单人版｜12秒

```text
Create a 12-second vertical 9:16 photorealistic social-dance video in one continuous take.

REFERENCES
Image 1 is the empty location reference only, not the literal opening frame. Image 2 identifies the only dancer, A. The first video frame already contains A in the room. Show exactly one person.

LOOK AND CAMERA
Use the room from Image 1 with bright, even light and a casual phone-video look. A faces the camera, with the whole body initially visible and clear floor space ahead. The camera is stationary, level and front-facing. No actual mirror, zoom, orbit or cuts. Foreground framing comes from the dancer moving closer, never from camera movement.

PERFORMANCE
Playful, cheeky, energetic and slightly goofy, not a polished concert performance. Use quick springy knee bends, weight shifts and expressive shoulders. Follow the phases in order; the timestamps are approximate.

0–2s: Start moving immediately. With a light step-touch bounce, A lifts one bent arm above the head and sweeps the forearm in two broad circular arcs, while the other arm pumps low across the torso. Make the circular gesture visible through the whole arm, not just a tiny finger movement.

2–4s: A brings both hands beside the head, elbows open, bends the knees and shifts the hips and shoulders left then right. Add a playful head toss; existing hair moves naturally. Do not invent long hair for a short-haired or bald person.

4–7s: A dances toward the camera for a head-to-waist foreground moment, gives a cheeky smile and a small outward palm flourish, then dances back far enough to turn. Keep the whole face visible; no nose-to-lens extreme close-up.

7–9s: A performs one complete 360-degree step-turn to their own right. Show side, back, opposite side, then front again. Head, torso and feet turn together. Finish facing the camera, balanced on the floor.

9–12s: A resumes bent-knee side-to-side steps with shoulder bounces and relaxed wrist flicks near shoulder height, then points playfully toward the lens. Hold a smiling finishing pose for the final half-second.

CONTINUITY
Preserve A's face, apparent age, skin tone, hairstyle, body proportions and visible outfit. Establish any unseen clothing once and keep it unchanged. Allow the face to be naturally hidden when the body turns away, then restore the same identity when facing forward.

AUDIO AND AVOID
No dialogue or lip-sync; the final original music will be added afterward. Avoid extra people, duplicates, cartoon chipmunks, animal transformation, face drift, outfit changes, extra limbs, fused hands, twisted necks, skating feet, endless spinning, teleportation, cinematic lighting changes, added text or watermarks.
```

## 双人版｜12秒

```text
Create a 12-second vertical 9:16 photorealistic two-person social-dance video in one continuous take.

REFERENCES
Image 1 supplies only the empty location, not the literal opening frame. A is the person in Image 2. B is the person in Image 3. Both are already present in the opening frame. Exactly two distinct people appear throughout.

STAGING AND CAMERA
Start with A on screen-left and half a step nearer the camera, and B on screen-right and half a step farther back. Screen directions mean the viewer's perspective. Leave a clear gap and room to dance forward. Use the room from Image 1 with bright, even phone-video lighting. Initially show both complete bodies. Keep the camera fixed and front-facing throughout. No mirror, zoom, cuts or camera rotation.

PERFORMANCE
A playful friends-doing-a-dance-challenge mood: springy knees, expressive shoulders and confident, slightly goofy faces. Match the major beats without making their smaller gestures mechanically identical. Follow the phases in order; timing is approximate.

0–1.5s: Both immediately bounce into step-touch footwork. Each lifts one bent arm above the head and makes broad circular forearm sweeps, with the other arm pumping low across the torso.

1.5–3.5s: A pivots halfway around to face B briefly, showing their back to the camera. Both bring hands beside the head with elbows open and make two bent-knee side-to-side hip-and-shoulder accents. A then turns back toward the camera. Keep them separated, with no contact or interlocking arms.

3.5–6s: A alone dances into the left foreground, showing a clear head-to-waist playful close moment with a head toss and smile, then eases diagonally back to screen-left. B keeps bouncing in the right background. A clears the foreground before B approaches.

6–8.5s: B alone dances into the right foreground, gives a cheeky expression and outward palm flourish, then eases diagonally back to screen-right. A remains in the left background. They never cross each other's paths.

8.5–10.5s: Both perform exactly one synchronized 360-degree step-turn to their own right on separate floor spots. Show side, back, opposite side and front. Finish facing the lens together.

10.5–12s: Both continue small bent-knee side steps and relaxed wrist flicks, then point toward the lens and hold a playful smiling pose for the last half-second.

CONTINUITY
Keep A and B individually recognizable, with unchanged faces, hairstyles, proportions, visible clothing and accessories. Preserve clothing inferred at the opening. Faces can naturally disappear during back views. No identity or outfit transfer when either dancer enters the foreground.

AUDIO AND AVOID
No dialogue or lip-sync; the final original music will be added afterward. Avoid a third person, cloning, face swaps, cartoon chipmunks, animal transformation, extra limbs, fused fingers, body intersections, both dancers rushing forward at once, sliding feet, incomplete turns, endless spins, teleportation, camera motion, added text or watermarks.
```

## 三人版｜15秒｜主模板

```text
Create a 15-second vertical 9:16 photorealistic three-person social-dance video in one continuous take.

REFERENCES
Image 1 supplies the empty location only, not the literal opening frame. A is the person in Image 2, B is the person in Image 3, and C is the person in Image 4. All three are already present at the start. Exactly these three distinct people appear.

STAGING
Begin in a shallow triangle: A at front-center, B a step behind on screen-left, C a step behind on screen-right. Leave clear gaps, with open left and right foreground lanes. All screen directions refer to the viewer. Preserve these identities even when positions change. This is a playful group dance with foreground handoffs, not a rigid horizontal chorus line.

LOOK AND CAMERA
Use the room from Image 1 with bright, even light and a natural phone-video look. Frame the complete bodies at their starting marks while keeping their faces readable. The camera stays fixed, level and front-facing. No mirror, cinematic camera movement, zooms or cuts. Approaches create head-to-waist foreground framing, not extreme face-only close-ups.

CHOREOGRAPHY
Follow these phases in order. Times are approximate; prioritize continuous movement and clean handoffs over exact timestamps.

0–2s: All three start a springy step-touch bounce. Each raises one bent arm above the head and sweeps the forearm in broad circles while the other arm pumps low across the torso. Keep the main accents in time, with individual playful expressions.

2–4s: A pivots 180 degrees to face B and C, briefly showing their back to the camera. All three bring hands beside the head, elbows open, and make two bent-knee side-to-side hip-and-shoulder accents. A pivots back to face the camera and keeps the center clear enough for the side-lane approaches.

4–6.5s: B alone advances through the left lane into a playful head-to-waist foreground moment, smiles and gives a small head toss, then eases diagonally back to the rear-left spot. A and C keep dancing behind. B clears the foreground before C starts.

6.5–9s: C alone advances through the right lane, makes a cheeky expression and relaxed outward palm flourish, then eases diagonally back to the rear-right spot. A and B stay behind. No crossing paths.

9–11.5s: A advances through the center lane, leans slightly toward the viewer with a mischievous smile and a small outward palm flourish, then steps back to the front-center mark. B and C remain behind and visible where not naturally occluded.

11.5–13.5s: All three perform one complete synchronized 360-degree step-turn to their own right on separate marks. Show side, back, opposite side, then front. Arms stay close enough to avoid collisions. Finish facing the camera.

13.5–15s: Continue the cheeky bent-knee side steps, shoulder bounces and relaxed wrist flicks. Finish with a playful camera-facing point and smiling group pose, held for the final half-second.

CONTINUITY
Preserve each person's face, hairstyle, skin tone, proportions, visible outfit and accessories separately. Keep any inferred clothing unchanged. Allow natural back views during turns. Temporary occlusion must not erase, clone or change a background dancer.

AUDIO AND AVOID
No dialogue or lip-sync; the final original music will be added afterward. Avoid extra people, identity blending, swapped outfits, cartoon chipmunks, animal transformation, extra limbs, fused hands, intersecting bodies, simultaneous foreground rushes, skating feet, teleportation, incomplete or repeated spins, camera movement, added text or watermarks.
```

## 圆耳发箍选配

三条原片中有两条戴圆耳头饰，一条是普通运动服、不戴头饰。它是可选视觉提示，不是必须条件。需要时，在对应视频提示词的角色段后添加：

```text
Add one small brown plush round-ear headband to each human as a costume accessory, present from the first frame and unchanged throughout. Keep their real human faces, hair, bodies and clothing; do not transform them into animals or cartoons.
```

## 首帧生图提示词有什么用

场景图是空房间；人物参考图说明客户是谁；首帧图是已经把这次客户放进房间、安排好站位的一张开场照片。

当前推荐：无人场景图 + 客户照片 + 对应视频提示词 → Seedance 多图参考 → 视频 → 合成自有原创母带。

可选加强路线：无人场景图 + 客户照片 + 首帧生图提示词 → 生图模型生成包含客户的开场合照 → 检查脸、衣服、人数和站位 → 合成图作为 Seedance 首帧 + 动作提示词 → 视频。

首帧生图提示词给生图模型使用，不是第二段Seedance视频提示词。输出图片才是要上传到首帧栏的东西。不同客户的首帧需要重新合成；内置空场景可以复用。

采用严格首帧路线时，不要原封不动保留上面的多图编号段：将 REFERENCES 段替换为“Use the supplied opening image as the first frame. Keep the same people, identities, clothing, room and starting positions.”，并按合成首帧中实际位置定义A/B/C。不要混用严格首帧与多图参考的输入角色。

## 验收重点

先检查大幅绕臂、背身互动（双人/三人）、轮流前景表演、后段完整转身、身份一致。最后半秒定格是产品化收尾，并不是三条原片共同存在的固定动作。未提供原创音轨，因此没有写死BPM，也不承诺生成动作自动逐拍对齐。

## 模型文档依据

- https://docs.byteplus.com/en/docs/modelark/seedance-2-0-prompt-guide
- https://console.byteplus.com/ark/region%3Aap-southeast-1/docs/create-video-generation-task-api

官方说明区分first_frame与reference_image；严格首帧/首尾帧模式和全能参考模式互斥。精确时间段执行不稳定，本文秒点为编排目标。
