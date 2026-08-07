// Storefront order flow. Vanilla JS, no build step.
//
// Responsibilities:
//   1. Load products.json (the single source of truth for pricing).
//   2. Render each card's price label from that catalog, so the card, the
//      dialog, and the Stripe line item can never show different numbers.
//   3. Open an accessible order dialog per product, in one of two modes:
//        - per-character  (house numbers, priced by character, multi-line)
//        - flat           (everything else, priced per unit with a quantity)
//   4. POST the configuration - never a price - to the checkout function and
//      redirect the buyer to Stripe Checkout.

(function () {
  'use strict';

  var CATALOG_URL = 'products.json';
  var CHECKOUT_ENDPOINT = '/api/create-checkout-session';

  var catalogPromise = null;

  function loadCatalog() {
    if (!catalogPromise) {
      catalogPromise = fetch(CATALOG_URL, { headers: { Accept: 'application/json' } }).then(
        function (res) {
          if (!res.ok) {
            throw new Error('Failed to load catalog: ' + res.status);
          }
          return res.json();
        }
      );
    }
    return catalogPromise;
  }

  function getProduct(catalog, id) {
    var product = null;
    catalog.products.forEach(function (p) {
      if (p.id === id) {
        product = p;
      }
    });
    return product;
  }

  // ---- Money -------------------------------------------------------------

  function formatUSD(cents) {
    var dollars = cents / 100;
    if (cents % 100 === 0) {
      return '$' + dollars;
    }
    return '$' + dollars.toFixed(2);
  }

  // ---- Card price labels -------------------------------------------------

  function renderCardPrices(catalog) {
    var cards = document.querySelectorAll('[data-product-id]');
    Array.prototype.forEach.call(cards, function (card) {
      var product = getProduct(catalog, card.getAttribute('data-product-id'));
      if (!product) {
        return;
      }
      var priceEl = card.querySelector('[data-price]');
      if (priceEl) {
        priceEl.textContent = '';
        priceEl.appendChild(document.createTextNode(formatUSD(product.pricing.unitAmount)));
        var unit = document.createElement('span');
        unit.className = 'unit';
        unit.textContent = product.pricing.unitLabel;
        priceEl.appendChild(unit);
      }
      var button = card.querySelector('[data-order]');
      if (button) {
        button.addEventListener('click', function () {
          openDialog(catalog, product, button);
        });
      }
    });
  }

  // ---- Focus trap --------------------------------------------------------

  var FOCUSABLE =
    'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

  function focusables(container) {
    return Array.prototype.slice.call(container.querySelectorAll(FOCUSABLE)).filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  // ---- Dialog ------------------------------------------------------------

  function openDialog(catalog, product, trigger) {
    var overlay = document.createElement('div');
    overlay.className = 'od-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'od-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    var titleId = 'od-title';
    dialog.setAttribute('aria-labelledby', titleId);

    // Header
    var header = document.createElement('div');
    header.className = 'od-header';
    var title = document.createElement('h2');
    title.className = 'od-title';
    title.id = titleId;
    title.textContent = product.name;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'od-close';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&times;';
    header.appendChild(title);
    header.appendChild(close);

    var body = document.createElement('div');
    body.className = 'od-body';

    var error = document.createElement('p');
    error.className = 'od-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    var ship = document.createElement('p');
    ship.className = 'od-ship';
    ship.textContent = catalog.shipWindow;

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'od-submit';
    var submitLabel = document.createElement('span');
    submitLabel.textContent = 'Continue to payment';
    var spinner = document.createElement('span');
    spinner.className = 'od-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    spinner.hidden = true;
    submit.appendChild(spinner);
    submit.appendChild(submitLabel);

    // Mode-specific controls return a getState() -> { valid, payload }
    var mode =
      product.pricing.model === 'per-character'
        ? perCharacterMode(product, body, refresh)
        : flatMode(product, body, refresh);

    body.appendChild(error);
    body.appendChild(ship);
    body.appendChild(submit);

    dialog.appendChild(header);
    dialog.appendChild(body);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Read state from body._state (set by both modes) rather than through
    // `mode`, because the first update() fires while `mode` is still being
    // assigned during construction.
    function refresh() {
      var state = body._state;
      submit.disabled = !(state && state.valid);
    }
    refresh();

    // ---- Open / close ----------------------------------------------------

    var lastFocus = trigger || document.activeElement;

    function destroy() {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.parentNode && overlay.parentNode.removeChild(overlay);
      if (lastFocus && typeof lastFocus.focus === 'function') {
        lastFocus.focus();
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        destroy();
        return;
      }
      if (e.key === 'Tab') {
        var items = focusables(dialog);
        if (items.length === 0) {
          return;
        }
        var first = items[0];
        var last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeydown, true);
    close.addEventListener('click', destroy);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) {
        destroy();
      }
    });

    // ---- Submit ----------------------------------------------------------

    submit.addEventListener('click', function () {
      var state = mode.getState();
      if (!state.valid) {
        return;
      }
      submit.disabled = true;
      spinner.hidden = false;
      error.hidden = true;

      fetch(CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.payload),
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          if (result.ok && result.data && result.data.url) {
            window.location.assign(result.data.url);
            return;
          }
          throw new Error(
            (result.data && result.data.error) || 'Unable to start checkout. Please try again.'
          );
        })
        .catch(function (err) {
          spinner.hidden = true;
          submit.disabled = false;
          error.textContent = err.message;
          error.hidden = false;
        });
    });

    // Move focus into the dialog.
    var initial = dialog.querySelector('input') || close;
    initial.focus();
  }

  // ---- Per-character mode (house numbers) --------------------------------

  function perCharacterMode(product, body, onChange) {
    var pricing = product.pricing;

    var intro = document.createElement('p');
    intro.className = 'od-intro';
    intro.textContent =
      'Enter the number for each sign you want. 1 to 6 letters or numbers per sign.';

    var linesWrap = document.createElement('div');
    linesWrap.className = 'od-lines';

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'od-add';
    addBtn.textContent = 'Add another sign';

    var calc = document.createElement('div');
    calc.className = 'od-calc';

    body.appendChild(intro);
    body.appendChild(linesWrap);
    body.appendChild(addBtn);
    body.appendChild(calc);

    var lineSeq = 0;

    function addLine() {
      var existing = linesWrap.querySelectorAll('.od-line').length;
      if (existing >= pricing.maxLines) {
        return;
      }
      lineSeq += 1;
      var id = 'od-sign-' + lineSeq;

      var row = document.createElement('div');
      row.className = 'od-line';

      var label = document.createElement('label');
      label.className = 'od-label';
      label.setAttribute('for', id);
      label.textContent = 'Sign ' + (existing + 1);

      var field = document.createElement('div');
      field.className = 'od-field';

      var input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.className = 'od-input';
      input.maxLength = 6;
      input.autocomplete = 'off';
      input.setAttribute('inputmode', 'text');
      input.setAttribute('aria-describedby', id + '-calc');

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'od-remove';
      remove.setAttribute('aria-label', 'Remove ' + label.textContent);
      remove.innerHTML = '&times;';

      field.appendChild(input);
      field.appendChild(remove);

      var lineCalc = document.createElement('p');
      lineCalc.className = 'od-line-calc';
      lineCalc.id = id + '-calc';

      row.appendChild(label);
      row.appendChild(field);
      row.appendChild(lineCalc);
      linesWrap.appendChild(row);

      input.addEventListener('input', function () {
        var upper = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (upper !== input.value) {
          input.value = upper;
        }
        update();
      });
      remove.addEventListener('click', function () {
        row.parentNode.removeChild(row);
        renumber();
        update();
      });

      update();
      input.focus();
    }

    function renumber() {
      var rows = linesWrap.querySelectorAll('.od-line');
      Array.prototype.forEach.call(rows, function (row, i) {
        var label = row.querySelector('.od-label');
        var remove = row.querySelector('.od-remove');
        label.textContent = 'Sign ' + (i + 1);
        remove.setAttribute('aria-label', 'Remove ' + label.textContent);
        remove.style.display = rows.length > 1 ? '' : 'none';
      });
    }

    function lineValues() {
      return Array.prototype.map.call(linesWrap.querySelectorAll('.od-input'), function (input) {
        return input.value;
      });
    }

    function update() {
      var rows = linesWrap.querySelectorAll('.od-line');
      var unit = formatUSD(pricing.unitAmount);
      var total = 0;
      var allValid = rows.length > 0;

      Array.prototype.forEach.call(rows, function (row) {
        var input = row.querySelector('.od-input');
        var lineCalc = row.querySelector('.od-line-calc');
        var value = input.value;
        var valid = /^[A-Z0-9]{1,6}$/.test(value);
        if (valid) {
          var chars = value.length;
          var lineTotal = chars * pricing.unitAmount;
          total += lineTotal;
          lineCalc.textContent =
            value +
            ' — ' +
            chars +
            (chars === 1 ? ' character × ' : ' characters × ') +
            unit +
            ' = ' +
            formatUSD(lineTotal);
          input.setAttribute('aria-invalid', 'false');
        } else {
          allValid = false;
          lineCalc.textContent = value.length
            ? 'Use 1 to 6 letters or numbers, no spaces.'
            : 'Enter the number for this sign.';
          input.setAttribute('aria-invalid', value.length ? 'true' : 'false');
        }
      });

      renumber();
      addBtn.disabled = rows.length >= pricing.maxLines;

      calc.innerHTML = '';
      if (allValid) {
        var totalEl = document.createElement('p');
        totalEl.className = 'od-total';
        totalEl.textContent = 'Order total ' + formatUSD(total);
        calc.appendChild(totalEl);
      }

      body._state = {
        valid: allValid,
        payload: { productId: product.id, lines: lineValues() },
      };
      onChange();
    }

    addBtn.addEventListener('click', addLine);
    addLine();

    return {
      getState: function () {
        return body._state;
      },
    };
  }

  // ---- Flat mode (everything else) ---------------------------------------

  function flatMode(product, body, onChange) {
    var pricing = product.pricing;
    var quantity = 1;

    var wrap = document.createElement('div');
    wrap.className = 'od-qty-wrap';

    var label = document.createElement('label');
    label.className = 'od-label';
    label.setAttribute('for', 'od-qty');
    label.textContent = 'Quantity';

    var stepper = document.createElement('div');
    stepper.className = 'od-qty';

    var minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'od-step';
    minus.setAttribute('aria-label', 'Decrease quantity');
    minus.textContent = '−';

    var input = document.createElement('input');
    input.type = 'number';
    input.id = 'od-qty';
    input.className = 'od-qty-input';
    input.min = 1;
    input.max = pricing.maxQuantity;
    input.value = String(quantity);
    input.setAttribute('inputmode', 'numeric');

    var plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'od-step';
    plus.setAttribute('aria-label', 'Increase quantity');
    plus.textContent = '+';

    stepper.appendChild(minus);
    stepper.appendChild(input);
    stepper.appendChild(plus);

    var calc = document.createElement('div');
    calc.className = 'od-calc';

    wrap.appendChild(label);
    wrap.appendChild(stepper);
    body.appendChild(wrap);
    body.appendChild(calc);

    function clamp(n) {
      if (isNaN(n)) {
        return 1;
      }
      return Math.max(1, Math.min(pricing.maxQuantity, Math.floor(n)));
    }

    function update() {
      quantity = clamp(parseInt(input.value, 10));
      input.value = String(quantity);
      minus.disabled = quantity <= 1;
      plus.disabled = quantity >= pricing.maxQuantity;

      var lineTotal = quantity * pricing.unitAmount;
      calc.innerHTML = '';
      var totalEl = document.createElement('p');
      totalEl.className = 'od-total';
      totalEl.textContent =
        quantity + ' × ' + formatUSD(pricing.unitAmount) + ' = ' + formatUSD(lineTotal);
      calc.appendChild(totalEl);

      body._state = {
        valid: true,
        payload: { productId: product.id, quantity: quantity },
      };
      onChange();
    }

    minus.addEventListener('click', function () {
      input.value = String(clamp(quantity - 1));
      update();
    });
    plus.addEventListener('click', function () {
      input.value = String(clamp(quantity + 1));
      update();
    });
    input.addEventListener('input', update);
    input.addEventListener('blur', update);

    update();

    return {
      getState: function () {
        return body._state;
      },
    };
  }

  // ---- Ship window (single-sourced from the catalog) ---------------------

  function renderShipWindow(catalog) {
    if (!catalog.shipWindow) {
      return;
    }
    var targets = document.querySelectorAll('[data-ship-window]');
    Array.prototype.forEach.call(targets, function (el) {
      el.textContent = catalog.shipWindow;
    });
  }

  // ---- Boot --------------------------------------------------------------

  function boot() {
    loadCatalog()
      .then(function (catalog) {
        renderCardPrices(catalog);
        renderShipWindow(catalog);
      })
      .catch(function (err) {
        // If the catalog cannot load, leave the static markup as-is rather
        // than blanking prices. Log for diagnosis.
        console.error(err);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
