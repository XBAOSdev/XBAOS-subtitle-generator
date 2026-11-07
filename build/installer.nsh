; 自定义 NSIS 脚本（electron-builder 会自动把 build/installer.nsh 作为 include 装进去）。
;
; 目前只做一件事：彻底清掉「双击 .xbsgp 用本软件打开」这条关联。
;
; electron-builder 自带的 unregisterFileAssociations 只删两处：
;   HKCU\Software\Classes\XBAOS.SubtitleProject              整棵子树
;   HKCU\Software\Classes\.xbsgp\OpenWithProgids             我们写进去的那个值
; 它**不删** .xbsgp 这个键本身 —— 该键的默认值仍然指着我们的 ProgID，而 ProgID 已经
; 被删了。留着就是一条「指向不存在程序」的死关联，回头用户再双击时，系统会拿着一份
; 失效的提示去问他「要用什么打开」。
;
; 补一刀，但守住两条底线：
;   1. 只在默认值**仍然等于**我们的 ProgID 时才删。用户后来把 .xbsgp 交给了别的程序，
;      这时删掉等于砸了别人的关联 —— 宁可留一个空键（无害），也不能错删；
;   2. 只删自己写过的值，再用 /ifempty 收尾，绝不 DeleteRegKey 整个键。
;      OpenWithProgids 里可能还躺着第三方注册的值。
;
; 一律走 HKCU：perMachine 为 false，安装器从不写 HKLM（所以也不需要管理员权限）。
; UserChoice（HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.xbsgp）
; 是系统托管、带哈希校验的记录，安装器既不写也不删 —— 动它会直接让系统的「默认应用」
; 配置失效。

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Classes\.xbsgp" ""
  ${If} $0 == "XBAOS.SubtitleProject"
    DeleteRegValue HKCU "Software\Classes\.xbsgp" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.xbsgp\OpenWithProgids" "XBAOS.SubtitleProject"
  DeleteRegKey /ifempty HKCU "Software\Classes\.xbsgp\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.xbsgp"
!macroend
