# TRICK 2022 "Best fishbowl" (Gold)

`entry.rb` is the gold-winning entry of TRICK 2022 (Transcendental Ruby Imbroglio Contest for RubyKaigi), copied unchanged.

- Author: Tomoya Ishida (tompng)
- Source: https://github.com/tric/trick2022/tree/main/01-tompng (commit a7cd01e); also in Ruby's repository as `sample/trick2022/01-tompng`
- License: MIT (see [LICENSE](LICENSE)); TRICK 2022 entries are submitted under the MIT License

It is an "aquatic quine": an 80 x 40 ASCII art fish tank animation in which every frame is itself a Ruby program that restores its missing characters and resumes the animation from that frame. See the author's [remarks](https://github.com/tric/trick2022/blob/main/01-tompng/remarks.markdown) for how it works.

`../trick2022-fishbowl-flow.json` runs it in a ruby-wasm node with frame mode, so each frame of the animation is one message in the Debug sidebar. The animation does not end: stop it with the *stop* inject (`msg.kill`).
