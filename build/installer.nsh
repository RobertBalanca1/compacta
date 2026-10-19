; Compacta 1.1.0: traducciones de las pantallas del instalador que electron-builder NO trae en arabe ni
; vietnamita (las rellena en ingles). Las pantallas estandar de NSIS (carpeta, progreso, botones) ya vienen
; traducidas por NSIS. Los numeros son los LCID de Windows: 1025 = arabe, 1066 = vietnamita.
;
; Va DENTRO de `customHeader` a proposito: electron-builder incluye sus mensajes (con el relleno en ingles) y este
; archivo en un orden que no esta garantizado (tareas asincronas), y en NSIS gana la ULTIMA definicion de un
; LangString. `customHeader` se ejecuta despues de todas las inclusiones, asi que siempre gana la nuestra.
!macro customHeader
  ; Arabe
  LangString chooseInstallationOptions 1025 "اختيار خيارات التثبيت"
  LangString chooseUninstallationOptions 1025 "اختيار خيارات إلغاء التثبيت"
  LangString whichInstallationShouldBeRemoved 1025 "أي تثبيت تريد إزالته؟"
  LangString whoShouldThisApplicationBeInstalledFor 1025 "لمن سيتم تثبيت هذا التطبيق؟"
  LangString selectUserMode 1025 "اختر ما إذا كنت تريد إتاحة هذا البرنامج لجميع المستخدمين أو لك وحدك"
  LangString whichInstallationRemove 1025 "هذا البرنامج مثبّت لكل جهاز (جميع المستخدمين) ولكل مستخدم.$\r$\nأي تثبيت تريد إزالته؟"
  LangString freshInstallForAll 1025 "تثبيت جديد لجميع المستخدمين. (سيُطلب منك إدخال بيانات المسؤول)"
  LangString freshInstallForCurrent 1025 "تثبيت جديد للمستخدم الحالي فقط."
  LangString onlyForMe 1025 "لي وحدي فقط"
  LangString forAll 1025 "أي شخص يستخدم هذا الكمبيوتر (جميع المستخدمين)"
  LangString loginWithAdminAccount 1025 "يجب تسجيل الدخول بحساب ينتمي إلى مجموعة المسؤولين للمتابعة..."
  LangString perUserInstallExists 1025 "يوجد بالفعل تثبيت لكل مستخدم."
  LangString perUserInstall 1025 "يوجد تثبيت لكل مستخدم."
  LangString perMachineInstallExists 1025 "يوجد بالفعل تثبيت لكل جهاز."
  LangString perMachineInstall 1025 "يوجد تثبيت لكل جهاز."
  LangString reinstallUpgrade 1025 "ستتم إعادة التثبيت/الترقية."
  LangString uninstall 1025 "ستتم إزالة التثبيت."
  ; Vietnamita
  LangString chooseInstallationOptions 1066 "Chọn tùy chọn cài đặt"
  LangString chooseUninstallationOptions 1066 "Chọn tùy chọn gỡ cài đặt"
  LangString whichInstallationShouldBeRemoved 1066 "Bạn muốn gỡ bản cài đặt nào?"
  LangString whoShouldThisApplicationBeInstalledFor 1066 "Ứng dụng này sẽ được cài đặt cho ai?"
  LangString selectUserMode 1066 "Hãy chọn cài đặt phần mềm này cho tất cả người dùng hay chỉ riêng bạn"
  LangString whichInstallationRemove 1066 "Phần mềm này được cài đặt cho cả máy (mọi người dùng) và cho từng người dùng.$\r$\nBạn muốn gỡ bản cài đặt nào?"
  LangString freshInstallForAll 1066 "Cài đặt mới cho tất cả người dùng. (sẽ yêu cầu thông tin quản trị viên)"
  LangString freshInstallForCurrent 1066 "Cài đặt mới chỉ cho người dùng hiện tại."
  LangString onlyForMe 1066 "Chỉ cho riêng tôi"
  LangString forAll 1066 "Bất kỳ ai dùng máy tính này (tất cả người dùng)"
  LangString loginWithAdminAccount 1066 "Bạn cần đăng nhập bằng tài khoản thuộc nhóm quản trị viên để tiếp tục..."
  LangString perUserInstallExists 1066 "Đã có bản cài đặt cho từng người dùng."
  LangString perUserInstall 1066 "Có một bản cài đặt cho từng người dùng."
  LangString perMachineInstallExists 1066 "Đã có bản cài đặt cho cả máy."
  LangString perMachineInstall 1066 "Có một bản cài đặt cho cả máy."
  LangString reinstallUpgrade 1066 "Sẽ cài đặt lại/nâng cấp."
  LangString uninstall 1066 "Sẽ gỡ cài đặt."
!macroend
