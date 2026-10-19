'use strict';

(function () {
  // Los ajustes sencillos (un control -> una clave): se guardan al cambiar y se cargan al abrir. El valor de
  // `load` cubre ajustes que faltan en perfiles guardados por versiones anteriores.
  const SIMPLE_SETTINGS = [
    { id: 'aggressiveToggle', key: 'aggressive', prop: 'checked', load: (v) => v },
    { id: 'webpToggle', key: 'convertToWebp', prop: 'checked', load: (v) => v },
    { id: 'heicToggle', key: 'heicAlwaysJpg', prop: 'checked', load: (v) => v === true },
    { id: 'maxCompressionToggle', key: 'maxCompression', prop: 'checked', load: (v) => v === true },
    { id: 'skipDuplicatesToggle', key: 'skipDuplicates', prop: 'checked', load: (v) => v !== false },
    { id: 'audioKindSelect', key: 'audioKind', prop: 'value', load: (v) => (v === 'voice' ? 'voice' : 'music') },
    { id: 'audioFormatSelect', key: 'audioFormat', prop: 'value', load: (v) => (['opus', 'flac'].includes(v) ? v : 'compat') }
  ];

  const t = (key, params) => window.I18n.t(key, params);

  // El perfil de fabrica se guarda con el nombre en español: se muestra en el idioma actual mientras no se renombre.
  const profileLabel = (p) => (p.id === 'default' && (!p.name || p.name === 'Por defecto') ? t('profile.default') : p.name);

  /** Abrir y cerrar el panel: boton, ✕, clic fuera y Escape (sin pisar a un cuadro de dialogo abierto). */
  function wireOverlay() {
    const overlay = document.getElementById('settingsOverlay');
    const close = () => overlay.classList.add('hidden');
    document.getElementById('settingsBtn').addEventListener('click', () => overlay.classList.remove('hidden'));
    document.getElementById('closeSettingsBtn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !window.Dialog.isOpen()) close();
    });
  }

  /** Calidad y los interruptores/selectores sencillos de SIMPLE_SETTINGS. */
  function wireSimpleSettings(onChange) {
    const qualitySlider = document.getElementById('qualitySlider');
    const qualityValue = document.getElementById('qualityValue');
    // El numero se actualiza mientras se arrastra, pero solo se guarda al
    // soltar. Antes se guardaba (mensaje al proceso principal + escritura a
    // disco) en cada pixel que se movia el slider.
    qualitySlider.addEventListener('input', () => {
      qualityValue.textContent = qualitySlider.value;
    });
    qualitySlider.addEventListener('change', () => {
      onChange({ quality: Number(qualitySlider.value) });
    });
    for (const setting of SIMPLE_SETTINGS) {
      const control = document.getElementById(setting.id);
      control.addEventListener('change', () => onChange({ [setting.key]: control[setting.prop] }));
    }
    return {
      show(settings) {
        qualitySlider.value = settings.quality;
        qualityValue.textContent = settings.quality;
        for (const setting of SIMPLE_SETTINGS) document.getElementById(setting.id)[setting.prop] = setting.load(settings[setting.key]);
      }
    };
  }

  /** Selector de perfil y sus tres botones (crear, renombrar, eliminar). Devuelve `render(perfiles, activo)`. */
  function wireProfiles({ onProfileCreate, onProfileRename, onProfileDelete, onProfileSwitch }) {
    const profileSelect = document.getElementById('profileSelect');
    const newProfileBtn = document.getElementById('newProfileBtn');
    const renameProfileBtn = document.getElementById('renameProfileBtn');
    const deleteProfileBtn = document.getElementById('deleteProfileBtn');

    profileSelect.addEventListener('change', () => {
      onProfileSwitch(profileSelect.value);
    });

    newProfileBtn.addEventListener('click', async () => {
      const name = await window.Dialog.prompt({
        title: t('profile.newTitle'),
        message: t('profile.newMessage'),
        value: t('profile.defaultName', { n: profileSelect.options.length + 1 }),
        okText: t('profile.create')
      });
      if (name) onProfileCreate(name);
    });

    renameProfileBtn.addEventListener('click', async () => {
      const current = profileSelect.options[profileSelect.selectedIndex];
      const name = await window.Dialog.prompt({
        title: t('profile.renameTitle'),
        value: current ? current.textContent : '',
        okText: t('profile.save')
      });
      if (name) onProfileRename(profileSelect.value, name);
    });

    deleteProfileBtn.addEventListener('click', async () => {
      if (deleteProfileBtn.disabled) return;
      const current = profileSelect.options[profileSelect.selectedIndex];
      const label = current ? current.textContent : t('profile.thisOne');
      const confirmed = await window.Dialog.confirm({
        title: t('profile.deleteTitle'),
        message: t('profile.deleteMessage', { name: label }),
        okText: t('dialog.delete'),
        danger: true
      });
      if (confirmed) onProfileDelete(profileSelect.value);
    });

    return function render(profiles, activeId) {
      profileSelect.innerHTML = '';
      (profiles || []).forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = profileLabel(p);
        if (p.id === activeId) opt.selected = true;
        profileSelect.appendChild(opt);
      });
      deleteProfileBtn.disabled = (profiles || []).length <= 1;
    };
  }

  /** Selector de idioma: «Automático» y cada idioma con su propio nombre (así se encuentra aunque no se entienda el actual). */
  function wireLanguage(onLanguageChange) {
    const languageSelect = document.getElementById('languageSelect');
    let state = null; // { languages, setting } que entrega el proceso principal
    languageSelect.addEventListener('change', () => onLanguageChange(languageSelect.value || null));
    return {
      setState(next) {
        state = next;
        this.render();
      },
      render() {
        if (!state) return;
        languageSelect.innerHTML = '';
        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = t('settings.language.auto');
        languageSelect.appendChild(auto);
        for (const language of state.languages) {
          const opt = document.createElement('option');
          opt.value = language.code;
          opt.textContent = language.name;
          languageSelect.appendChild(opt);
        }
        languageSelect.value = state.setting || '';
      }
    };
  }

  function init({ onChange, onProfileCreate, onProfileRename, onProfileDelete, onProfileSwitch, onLanguageChange }) {
    let lastSettings = null;
    wireOverlay();
    const simple = wireSimpleSettings(onChange);
    const renderProfiles = wireProfiles({ onProfileCreate, onProfileRename, onProfileDelete, onProfileSwitch });
    const language = wireLanguage(onLanguageChange);

    return {
      setLanguageState: (state) => language.setState(state),
      /** Cambio de idioma: textos que no son fijos del HTML (perfiles y selector de idioma). */
      refreshTexts() {
        language.render();
        if (lastSettings) renderProfiles(lastSettings.profiles, lastSettings.activeProfileId);
      },
      setValues(settings) {
        lastSettings = settings;
        simple.show(settings);
        renderProfiles(settings.profiles, settings.activeProfileId);
      }
    };
  }

  window.SettingsPanel = { init };
})();
