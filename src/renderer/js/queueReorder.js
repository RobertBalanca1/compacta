'use strict';

/**
 * Reordenar la cola: arrastrando una fila PENDIENTE (por cualquier parte, o por su asa) sobre otra fila
 * pendiente, o con Alt + flecha arriba/abajo desde el asa (para quien no usa
 * raton). El orden real lo decide el proceso principal (queue-manager.moveJob);
 * aqui solo se recoge el gesto. Un arrastre de ARCHIVOS desde fuera de la app no
 * se confunde con esto: usa un tipo propio, y la zona de soltar ignora los suyos.
 */
(function () {
  const list = document.getElementById('queueList');
  const DRAG_TYPE = 'application/x-compacta-job';
  let draggedId = null;

  const isPending = (li) => li && li.classList.contains('queue-item--pending');

  function clearMarks() {
    for (const li of list.querySelectorAll('.drop-before, .drop-after')) li.classList.remove('drop-before', 'drop-after');
  }

  /** Fila pendiente bajo el puntero y si cae en su mitad de abajo. */
  function targetFor(event) {
    const li = event.target.closest('li');
    if (!isPending(li) || li.dataset.id === draggedId) return null;
    const rect = li.getBoundingClientRect();
    return { li, after: event.clientY > rect.top + rect.height / 2 };
  }

  list.addEventListener('dragstart', (event) => {
    // Se puede agarrar la fila ENTERA (no solo el asa); el asa sigue siendo la pista visual y la via del teclado.
    const li = event.target.closest ? event.target.closest('li') : null;
    if (!isPending(li)) {
      event.preventDefault(); // solo lo que aun no empezo se puede mover
      return;
    }
    draggedId = li.dataset.id;
    event.dataTransfer.setData(DRAG_TYPE, draggedId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setDragImage(li, 20, 20);
    li.classList.add('dragging');
  });

  list.addEventListener('dragover', (event) => {
    if (!draggedId || !Array.from(event.dataTransfer.types).includes(DRAG_TYPE)) return;
    clearMarks();
    const target = targetFor(event);
    if (!target) return;
    event.preventDefault(); // permite soltar aqui
    event.dataTransfer.dropEffect = 'move';
    target.li.classList.add(target.after ? 'drop-after' : 'drop-before');
  });

  list.addEventListener('dragleave', (event) => {
    if (!list.contains(event.relatedTarget)) clearMarks();
  });

  list.addEventListener('drop', async (event) => {
    if (!draggedId) return;
    const target = targetFor(event);
    clearMarks();
    if (!target) return;
    event.preventDefault();
    const id = draggedId;
    draggedId = null;
    await window.api.moveJob(id, target.li.dataset.id, target.after);
  });

  list.addEventListener('dragend', () => {
    draggedId = null;
    clearMarks();
    for (const li of list.querySelectorAll('.dragging')) li.classList.remove('dragging');
  });

  // Teclado: Alt + flecha desde el asa mueve la fila una posicion entre las pendientes.
  list.addEventListener('keydown', async (event) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const grip = event.target.closest('.queue-item__grip');
    const li = grip && grip.closest('li');
    if (!isPending(li)) return;
    event.preventDefault();
    const up = event.key === 'ArrowUp';
    let neighbour = up ? li.previousElementSibling : li.nextElementSibling;
    while (neighbour && !isPending(neighbour)) neighbour = up ? neighbour.previousElementSibling : neighbour.nextElementSibling;
    if (!neighbour) return;
    // La fila se recoloca con la siguiente actualizacion; queueView.js devuelve el foco al asa.
    await window.api.moveJob(li.dataset.id, neighbour.dataset.id, !up);
  });
})();
