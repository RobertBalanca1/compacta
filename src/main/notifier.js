'use strict';

const { t, isolate } = require('../shared/i18n');

/**
 * Aviso de "lote terminado". Dos canales a la vez, porque cualquiera de los
 * dos puede fallar en el equipo de alguien:
 *
 *  1. Notificacion del sistema (Windows / macOS). En macOS exige que el
 *     usuario haya permitido las notificaciones de la app, y una app sin
 *     firmar o lanzada en modo desarrollo a veces no las muestra.
 *  2. Aviso dentro de la propia ventana (verde). Ese no depende de ningun
 *     permiso del sistema operativo, asi que siempre se ve.
 *
 * Ademas, si la ventana esta en segundo plano, se pide atencion (el icono
 * rebota en el Dock de Mac / parpadea en la barra de tareas de Windows).
 *
 * Version anterior: solo avisaba si la ventana NO tenia el foco -- o sea,
 * nunca cuando la persona estaba mirando la app, que es justo cuando prueba
 * la funcion -- y disparaba al pulsar Detener en vez de al terminar.
 */

const NOTIFY_THRESHOLD = 5;

let notificationFactory = null; // reemplazable en pruebas

function defaultFactory(options) {
  const { Notification } = require('electron');
  if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return null;
  return new Notification(options);
}

/** Solo para pruebas: permite espiar la notificacion sin abrir una real. */
function setNotificationFactory(factory) {
  notificationFactory = factory;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Texto del aviso, o null si el lote es demasiado pequeño para molestar. */
function describeBatch(summary) {
  if (!summary || summary.done < NOTIFY_THRESHOLD) return null;
  let message = t('notify.done', { count: summary.done });
  if (summary.savedBytes > 0) message += t('notify.saved', { size: isolate(formatBytes(summary.savedBytes)) });
  if (summary.errors > 0) message += t('notify.errors', { count: summary.errors });
  return message;
}

/**
 * @param summary   { done, errors, savedBytes } que entrega queue-manager
 * @param win       BrowserWindow actual, o null si no hay ventana abierta
 * @returns el texto mostrado, o null si no correspondia avisar
 */
function announceBatchFinished(summary, win) {
  const message = describeBatch(summary);
  if (!message) return null;

  const alive = win && !win.isDestroyed();

  if (alive) {
    try {
      win.webContents.send('queue:batch-finished', message);
    } catch (err) {
      console.error('[notifier] no se pudo avisar dentro de la app:', err);
    }
  }

  try {
    const factory = notificationFactory || defaultFactory;
    const notification = factory({ title: 'Compacta', body: message });
    if (notification) notification.show();
  } catch (err) {
    console.error('[notifier] no se pudo mostrar la notificacion del sistema:', err);
  }

  if (alive && !win.isFocused()) {
    try {
      win.flashFrame(true);
      const { app } = require('electron');
      if (app && app.dock && typeof app.dock.bounce === 'function') app.dock.bounce('informational');
    } catch {
      // Pedir atencion es un extra; si falla no pasa nada.
    }
  }

  return message;
}

module.exports = {
  formatBytes,
  describeBatch,
  announceBatchFinished,
  setNotificationFactory
};
