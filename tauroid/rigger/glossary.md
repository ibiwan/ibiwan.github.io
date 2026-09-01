### engine
any downstream consumer of this tool's output, \
e.g. a game engine rendering character poses and animation
### scene
the workspace, with world reference frame, skeleton, bound graphics, configurations, constraints, animations
### skeleton
a set of bones with their attachments
### paper doll
skeleton with bound art \
and optionally, constraints and/or animations
### graphic
a piece of art used as a component of the paper doll. \
not deformed, but can be scaled
### configuration
a skeleton with art bindings and with all bone deltas set
### mode
the app state selecting which configuration should be displayed (and which editable)
### bone
a line segment defined by a reference anchor's position and angle, and a length. \
can also have deltas and locks and constraints
### lock
a toggle that can keep a value from being edited by dragging
### attach
associate a bone to an anchor (inherit x/y/a)
### delta
a relative distance or angle value intended to be added to a working distance or angle
### delta set
a set of x/y/angle deltas to be added to a working position+orientation
### bind
associate a graphic to an anchor
use art anchors to position/orient
### anchor
types: **world**, **root**, **tip**, **art** 

a named entity with:
  * parent (except for world frame)
  * x, y position
  * angle (explicit, inherited, or computed)
### world anchor
x:0,y:0,a:0 in the overall scene, always exists. \
default anchor for all bones and graphics.
### root anchor
auto-created at each bone's starting point \
(length not included)
### tip anchor
auto-created at each bone's tip \
(after extending by *length* at *angle*)
### art anchor
named point manually placed within a graphic
takes base direction of bound anchor \
no special roles granted by name choice
### origin anchor
art anchor selected to define the art's 0,0 position
### direction anchor
art anchor selected to define the art's direction vector (as vector diff from origin)
### reference frame
coordinate plane defined by an anchor
### rest configuration
skeleton with rest deltas applied. \
generic arrangement of parts.
### solve configuration
rest configuration, with constraint angles replacing rest where defined \
(and positions, when applicable)
### pose configuration
specific interesting arrangement of parts. \
solve configuration, but with "poseAngle" deltas applied before solve is computed.
### anim configuration
as pose configuration, but with per-keyframe deltas applied before solve is computed. \
used for animations as distinct from static poses
### bundle
a downloadable zip with:
* all customized graphics
* a json file with full authored rig, reloadable
* a yaml file with flattened coordinates for the engine's use, including baked animations
### baked
animation with constraints pre-solved plus enough added baked keys that tweening produces the same result.  
### constraint
an implicit definition of a bone's angle or other parameters \
types:
**pose**, **aim**, **reach**, **match**
### pose constraint (default)
the set of deltas directly defined on a bone
### aim constraint
overrides angle such that the bone points toward a chosen target anchor
### reach constraint
overrides angles on specified bone and its parent bone such that they attempt to end on a chosen target anchor
### match constraint
overrides a subset of position/angle to match that of a chosen target anchor; \
further deltas can be applied after, in world or target reference frame
### solve
an attempt to arrange pose/anim/solve configuration values to satisfy all constraints simultaneously
### solution
output of a solve
### animation
a motion defined by a series of keyframes \
includes type, length and one or more keyframes \
types: **one-shot**, **forward loop**, **back-and-forth**
### keyframe
used by animation, has a frame number and a delta set for any selection of bones. \
constraints are solved after applying deltas
### baked key
emitted, specifying the value for a single bone's single attribute at a given frame number
### turn
a keyframe option that defines whether angle deltas are interpreted as increasing, decreasing, or automatic shortest-path
### one-shot
animation type that has at least start and end keyframes, and just tweens between them then stops on the end keyframe
### forward loop
animation type that has at least a start frame, reused as an implicit "beyond-last" frame
### back-and-forth loop
animation type that has at least start and end keyframes, and tweens between them before reversing
### timeline
the set of all active animations, displayed in sync. \
includes an fps value for playback rate
### lane
the display of a single animation in the timeline. \
click in a lane to create a keyframe
