- 踏踏实实写test，多写test，让test coverage尽可能高

- 认真做好CI/CD，千方百计避免messed up

- 对于一个新项目，做好top-down design（specs driven），从features和requirement出发，设计architecture 和 interface，一层一层设计下去

- 对于一个快速增长的项目，先切分好文件，再切分好module，再划分成一堆service或者executives，提前解耦

- 对于一类的功能，提前做好design pattern的功课，减少重复，增加复用

- 如果codebase足够大，要么一点点修复但是提高test coverage，要么保持好specs、test、interface直接推倒重写，有空就重写， 永远重写，重写重写重写
