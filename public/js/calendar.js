window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.day-cell').forEach(cell => {
    const motivace = parseInt(cell.querySelector('select[name="motivace"]').value);
    const spokojenost = parseInt(cell.querySelector('select[name="spokojenost"]').value);

    if (motivace > 0 || spokojenost > 0) {
      cell.classList.add('filled');
    }
  });
});
