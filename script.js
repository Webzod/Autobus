// ════════════════════════════════════════════
// ⚙️ CONFIGURACIÓN Y UTILIDADES
// ════════════════════════════════════════════
// ════════════════════════════════════════════
// 🔥 CONEXIÓN A FIREBASE (stock compartido en tiempo real)
// ════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyDu3dpz65Epwl6Ru5gsWyh0-4HH_EeZTSs",
  authDomain: "arzotrans-stock-4978f.firebaseapp.com",
  databaseURL: "https://arzotrans-stock-4978f-default-rtdb.firebaseio.com",
  projectId: "arzotrans-stock-4978f",
  storageBucket: "arzotrans-stock-4978f.firebasestorage.app",
  messagingSenderId: "593123001849",
  appId: "1:593123001849:web:d556f50822a19d0eafa928"
};
firebase.initializeApp(firebaseConfig);
const firebaseDb = firebase.database();
const stockRef = firebaseDb.ref('stock');
const activityRef = firebaseDb.ref('activity');
const reservationsRef = firebaseDb.ref('reservations');
const holdsRef = firebaseDb.ref('holds'); // reservas temporales de carrito (ver sección 20)
const stockMetaRef = firebaseDb.ref('stockMeta'); // guarda cuándo fue el último reset de cada ruta
const shortIdsRef = firebaseDb.ref('shortIds'); // registro de códigos cortos ya usados, para evitar duplicados

// NOTA DE SEGURIDAD IMPORTANTE:
// Este archivo corre en el navegador del cliente, así que cualquiera
// puede leer firebaseConfig y llamar a la base de datos directo,
// sin pasar por esta página. Lo único que te protege de verdad son
// las REGLAS de seguridad configuradas en la consola de Firebase
// (Realtime Database > Reglas). Sin reglas correctas, la contraseña
// del panel de administración de más abajo es solo una traba visual,
// no una protección real. Ver firebase.rules.json adjunto.

const logStockActivity = (id, qty) => {
    const key = encodeStockKey(id);
    activityRef.child(key).push({ qty: qty, ts: Date.now() })
        .catch(err => console.error('No se pudo registrar actividad de stock:', err));
};

const encodeStockKey = (id) => encodeURIComponent(id).replace(/\./g, '%2E');

// ════════════════════════════════════════════
// 🧹 LIMPIEZA PERIÓDICA DE CÓDIGOS CORTOS VIEJOS
// ════════════════════════════════════════════
// El nodo shortIds nunca se borra solo, así que con el tiempo va
// acumulando entradas de reservas viejas. Esto no afecta la velocidad
// ni el funcionamiento (Firebase indexa por clave), pero por prolijidad
// (y para mantener el espacio de combinaciones lo más "libre" posible)
// borramos automáticamente, una vez por sesión, los códigos con más de
// SHORT_ID_CLEANUP_DAYS de antigüedad. No hace falta tocar nada de esto
// a mano ni programarlo aparte: se ejecuta solo, en segundo plano, sin
// bloquear ni afectar al cliente.
const SHORT_ID_CLEANUP_DAYS = 180; // 6 meses
const cleanupOldShortIds = async () => {
    try {
        const cutoff = Date.now() - (SHORT_ID_CLEANUP_DAYS * 24 * 60 * 60 * 1000);
        const snap = await shortIdsRef.orderByValue().endAt(cutoff).once('value');
        const val = snap.val();
        if (!val) return; // nada viejo para borrar
        const updates = {};
        Object.keys(val).forEach(id => { updates[id] = null; });
        await shortIdsRef.update(updates);
        console.log(`Limpieza de códigos de reserva: se liberaron ${Object.keys(updates).length} código(s) viejo(s).`);
    } catch (err) {
        // Si falla (por ejemplo, falta el índice en las reglas de Firebase),
        // no afecta el funcionamiento del sitio: simplemente no se limpia
        // esta vez y se reintenta en la próxima visita de algún cliente.
        console.error('No se pudo limpiar códigos de reserva viejos (no es crítico):', err);
    }
};

const WHATSAPP_NUMBER = "5491123456789";
const isTouchDevice = () => {
    return (('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0));
};

const debounce = (fn, wait = 250) => {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
};

// ════════════════════════════════════════════
// 🆔 ID CORTO DE RESERVA (ej. "A4F2R")
// ════════════════════════════════════════════
// 5 caracteres (antes 4) para ampliar el espacio de combinaciones:
// 32^5 = 33.554.432 posibles, contra 32^4 = 1.048.576 de antes. Sigue
// siendo corto y fácil de dictar por WhatsApp, pero deja mucho más
// margen a medida que el negocio crece.
const SHORT_ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O, 1/I para evitar confusiones
const SHORT_ID_LENGTH = 5;
const generateShortId = () => {
    let id = '';
    for (let i = 0; i < SHORT_ID_LENGTH; i++) id += SHORT_ID_CHARS[Math.floor(Math.random() * SHORT_ID_CHARS.length)];
    return id;
};

// Genera un código corto y, antes de devolverlo, chequea contra Firebase que
// nadie más lo esté usando. Si está ocupado, prueba con otro (hasta 10
// intentos). Al encontrar uno libre, lo "reserva" de inmediato en el nodo
// shortIds para que dos clientes confirmando al mismo tiempo no puedan
// terminar con el mismo código.
const generateUniqueShortId = async (maxAttempts = 10) => {
    for (let i = 0; i < maxAttempts; i++) {
        const id = generateShortId();
        try {
            const snap = await shortIdsRef.child(id).once('value');
            if (!snap.exists()) {
                await shortIdsRef.child(id).set(Date.now());
                return id;
            }
        } catch (err) {
            console.error('No se pudo verificar unicidad del código de reserva, se usará igual:', err);
            return id; // mejor devolver uno (aunque no verificado) que bloquear el flujo del cliente
        }
    }
    // Caso extremadamente improbable: 10 intentos y todos ocupados.
    // Devolvemos uno igual para no trabar al cliente.
    console.warn('No se encontró un código de reserva único tras varios intentos.');
    return generateShortId();
};

document.addEventListener('DOMContentLoaded', () => {

    // ════════════════════════════════════════════
    // 🌎 0. DETECCIÓN DE DISPOSITIVO/SO PARA EL SELECT DE PAÍSES
    // ════════════════════════════════════════════
    (function setupCountrySelectDisplay() {
        const countrySelect = document.getElementById('checkoutCountryCode');
        if (!countrySelect) return;

        const options = Array.from(countrySelect.options);

        const renderAsFlag = () => {
            options.forEach(opt => {
                const [code] = opt.value.split('|');
                const flag = opt.getAttribute('data-flag');
                opt.textContent = `${flag} ${code}`;
            });
        };

        const renderAsText = () => {
            options.forEach(opt => {
                const [code, countryName] = opt.value.split('|');
                const abbr = opt.getAttribute('data-abbr');
                opt.textContent = `${abbr} ${code} ${countryName}`;
            });
        };

        const ua = navigator.userAgent;
        const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
        const isWindows = /Windows NT/i.test(ua);
        const isMac = /Macintosh|Mac OS X/i.test(ua);
        const isLinux = /Linux/i.test(ua) && !isMobile;

        if (isMobile || isMac || isLinux) {
            renderAsFlag();
            return;
        }

        if (isWindows) {
            renderAsText();
            if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
                navigator.userAgentData.getHighEntropyValues(['platformVersion'])
                    .then(info => {
                        if (info.platform === 'Windows' && info.platformVersion) {
                            const majorVersion = parseInt(info.platformVersion.split('.')[0], 10);
                            if (majorVersion >= 13) {
                                renderAsFlag();
                            }
                        }
                    })
                    .catch(() => { /* se queda en modo texto (seguro) */ });
            }
            return;
        }

        renderAsText();
    })();

        // 0. AÑO ACTUAL EN EL FOOTER (se actualiza solo, no hace falta tocarlo nunca más)
    const currentYearEl = document.getElementById('currentYear');
    if (currentYearEl) currentYearEl.textContent = new Date().getFullYear();

    // Limpieza en segundo plano de códigos de reserva viejos (no bloquea
    // nada de lo que ve o hace el cliente; ver cleanupOldShortIds arriba).
    cleanupOldShortIds();

    // 1. LOADER
    const loader = document.getElementById('loader');
    setTimeout(() => {
        loader.style.opacity = '0';
        setTimeout(() => loader.style.display = 'none', 500);
    }, 2000);

    // 2. PÉTALOS/DETALLES FLOTANTES EN EL HERO
      const heroPetals = document.getElementById('heroPetals');
    if (heroPetals) {
        for (let i = 0; i < 14; i++) {
            let ticket = document.createElement('div');
            ticket.className = 'hero-ticket';
            ticket.style.left = Math.random() * 100 + '%';
            ticket.style.top = '-10%';
            ticket.style.opacity = Math.random() * 0.4 + 0.4;
            ticket.style.animation = `petalFall ${Math.random() * 7 + 8}s linear infinite`;
            ticket.style.animationDelay = `${Math.random() * 8}s`;
            heroPetals.appendChild(ticket);
        }
    }

    // 3. CURSOR PERSONALIZADO
    const cursor = document.querySelector('.custom-cursor');
    if (cursor && !isTouchDevice()) {
        cursor.style.display = 'block';
        let mouseX = 0, mouseY = 0, cursorX = 0, cursorY = 0;
        document.addEventListener('mousemove', (e) => {
            mouseX = e.clientX;
            mouseY = e.clientY;
        });
        const renderCursor = () => {
            cursorX += (mouseX - cursorX) * 0.2;
            cursorY += (mouseY - cursorY) * 0.2;
            cursor.style.transform = `translate(${cursorX}px, ${cursorY}px)`;
            requestAnimationFrame(renderCursor);
        };
        renderCursor();
    }

    // 4. BARRA PROGRESO SCROLL & HEADER TRANSPARENTE
    const scrollProgress = document.getElementById('scrollProgress');
    const header = document.getElementById('header');
    window.addEventListener('scroll', () => {
        let scrollTop = window.scrollY;
        let docHeight = document.body.offsetHeight - window.innerHeight;
        let scrollPercent = (scrollTop / docHeight) * 100;
        if (scrollProgress) scrollProgress.style.width = scrollPercent + '%';
        if (scrollTop > 80) header.classList.add('scrolled');
        else header.classList.remove('scrolled');
    });

    // 5. TYPEWRITER HERO
    const typeTexts = ["Tu destino, nuestra ruta.", "Viaja seguro y puntual.", "Comodidad en cada kilómetro."];
    let typeIndex = 0, charIndex = 0, isDeleting = false;
    const typeElement = document.getElementById('typewriter');
    const typeWriter = () => {
        const currentText = typeTexts[typeIndex];
        if (isDeleting) {
            typeElement.textContent = currentText.substring(0, charIndex - 1);
            charIndex--;
        } else {
            typeElement.textContent = currentText.substring(0, charIndex + 1);
            charIndex++;
        }
        let typeSpeed = isDeleting ? 50 : 100;
        if (!isDeleting && charIndex === currentText.length) {
            typeSpeed = 2000;
            isDeleting = true;
        } else if (isDeleting && charIndex === 0) {
            isDeleting = false;
            typeIndex = (typeIndex + 1) % typeTexts.length;
            typeSpeed = 500;
        }
        setTimeout(typeWriter, typeSpeed);
    };
    if (typeElement) setTimeout(typeWriter, 2500);

    // 6. SCROLL REVEAL & STAGGER
    const revealElements = document.querySelectorAll('.reveal');
    const revealObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0, rootMargin: '0px 0px -10% 0px' });
    revealElements.forEach(el => revealObserver.observe(el));

    const staggerObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });
    document.querySelectorAll('.stagger-item').forEach(item => staggerObserver.observe(item));

    // 7. CONTADORES ANIMADOS
    const counters = document.querySelectorAll('.stat-number');
    const counterObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const targetStr = entry.target.getAttribute('data-target');
                const isDecimal = entry.target.getAttribute('data-decimal') === "true";
                const target = parseFloat(targetStr);
                let count = 0;
                const duration = 2000;
                const increment = target / (duration / 16);
                const updateCount = () => {
                    count += increment;
                    if (count < target) {
                        entry.target.innerText = isDecimal ? count.toFixed(1) : Math.ceil(count);
                        requestAnimationFrame(updateCount);
                    } else {
                        entry.target.innerText = isDecimal ? target.toFixed(1) : target;
                    }
                };
                updateCount();
                obs.unobserve(entry.target);
            }
        });
    });
    counters.forEach(counter => counterObserver.observe(counter));

    // 8. TILT 3D HOVER (Solo Desktop)
    if (!isTouchDevice()) {
        const tiltCards = document.querySelectorAll('.tilt-card');
        tiltCards.forEach(card => {
            card.addEventListener('mousemove', (e) => {
                const rect = card.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const centerX = rect.width / 2;
                const centerY = rect.height / 2;
                const rotateX = ((y - centerY) / centerY) * -10;
                const rotateY = ((x - centerX) / centerX) * 10;
                card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
            });
            card.addEventListener('mouseleave', () => {
                card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)`;
            });
        });
    }

    // 9. FILTROS CATÁLOGO
    const filterBtns = document.querySelectorAll('.filter-btn');
    const catalogItems = document.querySelectorAll('.catalog-item');
    const filterTriggers = document.querySelectorAll('.filter-trigger');
    const categoryEmptyMsg = document.getElementById('categoryEmpty');

    const applyFilter = (filterValue) => {
        filterBtns.forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.filter-btn[data-filter="${filterValue}"]`);
        if (btn) btn.classList.add('active');

        let hasAnyInCategory = filterValue === 'all';
        catalogItems.forEach(item => {
            if (item.getAttribute('data-category') === filterValue) hasAnyInCategory = true;
        });
        if (categoryEmptyMsg) {
            categoryEmptyMsg.style.display = (!hasAnyInCategory) ? 'block' : 'none';
        }

        catalogItems.forEach(item => {
            item.style.opacity = '0';
            item.style.transform = 'scale(0.9)';
            setTimeout(() => {
                if (filterValue === 'all' || item.getAttribute('data-category') === filterValue) {
                    item.classList.remove('hidden');
                    void item.offsetWidth;
                    item.style.opacity = '1';
                    item.style.transform = 'scale(1)';
                } else {
                    item.classList.add('hidden');
                }
            }, 300);
        });
    };

    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-search-input').forEach(input => input.value = '');
            const noResults = document.getElementById('noResults');
            if (noResults) noResults.style.display = 'none';
            applyFilter(btn.getAttribute('data-filter'));
        });
    });

    filterTriggers.forEach(trigger => {
        trigger.addEventListener('click', (e) => {
            const f = trigger.getAttribute('data-t');
            applyFilter(f);
        });
    });

    // ➡️ FLECHAS PARA DESPLAZAR LOS FILTROS DEL CATÁLOGO
    const filtersScroll = document.getElementById('filtersScroll');
    const filtersPrevBtn = document.getElementById('filtersPrev');
    const filtersNextBtn = document.getElementById('filtersNext');
    if (filtersScroll && filtersPrevBtn && filtersNextBtn) {
        const scrollAmount = 240;
        filtersPrevBtn.addEventListener('click', () => {
            filtersScroll.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
        });
        filtersNextBtn.addEventListener('click', () => {
            filtersScroll.scrollBy({ left: scrollAmount, behavior: 'smooth' });
        });
        const updateFilterArrows = () => {
            const maxScroll = filtersScroll.scrollWidth - filtersScroll.clientWidth;
            filtersPrevBtn.disabled = filtersScroll.scrollLeft <= 2;
            filtersNextBtn.disabled = filtersScroll.scrollLeft >= maxScroll - 2;
        };
        filtersScroll.addEventListener('scroll', updateFilterArrows);
        window.addEventListener('resize', updateFilterArrows);
        updateFilterArrows();
    }

    // 🔲 VISTA DE CUADRÍCULA / LISTA
    const viewGridBtn = document.getElementById('viewGridBtn');
    const viewListBtn = document.getElementById('viewListBtn');
    const catalogGridView = document.getElementById('catalogGrid');
    if (viewGridBtn && viewListBtn && catalogGridView) {
        const setView = (mode) => {
            const isList = mode === 'list';
            catalogGridView.classList.toggle('list-view', isList);
            viewGridBtn.setAttribute('aria-pressed', String(!isList));
            viewListBtn.setAttribute('aria-pressed', String(isList));
        };
        viewGridBtn.addEventListener('click', () => setView('grid'));
        viewListBtn.addEventListener('click', () => setView('list'));
    }

    // 10. CARRUSEL DESTACADOS
    const featTrack = document.getElementById('featuredTrack');
    const featSlides = document.querySelectorAll('.featured-slide');
    const featNext = document.getElementById('featNext');
    const featPrev = document.getElementById('featPrev');
    const featDotsContainer = document.getElementById('featDots');
    let featIndex = 0;
    let featInterval;

    if (featTrack && featDotsContainer && featSlides.length) {
        featSlides.forEach((_, i) => {
            let d = document.createElement('div');
            d.classList.add('dot');
            if (i === 0) d.classList.add('active');
            d.addEventListener('click', () => goToFeatSlide(i));
            featDotsContainer.appendChild(d);
        });
        const featDots = document.querySelectorAll('#featDots .dot');

        var goToFeatSlide = (index) => {
            featIndex = index;
            if (featIndex < 0) featIndex = featSlides.length - 1;
            if (featIndex >= featSlides.length) featIndex = 0;
            featTrack.style.transform = `translateX(-${featIndex * 100}%)`;
            featDots.forEach(d => d.classList.remove('active'));
            featDots[featIndex].classList.add('active');
        };

        if (featNext) featNext.addEventListener('click', () => goToFeatSlide(featIndex + 1));
        if (featPrev) featPrev.addEventListener('click', () => goToFeatSlide(featIndex - 1));

        const startFeatAutoplay = () => { featInterval = setInterval(() => goToFeatSlide(featIndex + 1), 5000); };
        const stopFeatAutoplay = () => { clearInterval(featInterval); };

        const carouselEl = document.querySelector('.featured-carousel');
        if (carouselEl) {
            carouselEl.addEventListener('mouseenter', stopFeatAutoplay);
            carouselEl.addEventListener('mouseleave', startFeatAutoplay);
        }
        startFeatAutoplay();
    }

    // 11. ACORDEÓN FAQ
    const faqItems = document.querySelectorAll('.faq-item');
    faqItems.forEach(item => {
        const header = item.querySelector('.faq-header');
        header.addEventListener('click', () => {
            const isActive = item.classList.contains('active');
            faqItems.forEach(faq => {
                faq.classList.remove('active');
                faq.querySelector('.faq-content').style.maxHeight = null;
            });
            if (!isActive) {
                item.classList.add('active');
                const content = item.querySelector('.faq-content');
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
    });

    // 12. MENÚ MÓVIL (Hamburguesa)
    const hamburger = document.querySelector('.hamburger-menu');
    const navList = document.querySelector('.nav-list');
    const navLinks = document.querySelectorAll('.nav-link');
    if (hamburger) {
        hamburger.addEventListener('click', () => {
            navList.classList.toggle('active');
        });
    }
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            navList.classList.remove('active');
        });
    });
    

    // 13. PARALLAX HERO
    const heroBg = document.querySelector('.hero-bg');
    window.addEventListener('scroll', () => {
        if (heroBg && window.scrollY < window.innerHeight) {
            heroBg.style.transform = `translateY(${window.scrollY * 0.4}px)`;
        }
    });

    // ════════════════════════════════════════════
    // 🛒 14. CARRITO DE BOLETOS (FUNCIONAL, 2 PASOS + CONFIRMACIÓN)
    // ════════════════════════════════════════════
    //
    // CAMBIO CLAVE (nuevo): la reserva YA NO se guarda en Firebase en
    // el momento de presionar "Confirmar por WhatsApp". Ese botón
    // ahora solo ABRE WhatsApp con el mensaje prellenado (que ya
    // incluye el ID corto de la reserva, ej. "Reserva #A4F2") y
    // muestra un tercer paso: "¿Ya enviaste el mensaje?" con un botón
    // "✅ Ya confirmé por WhatsApp".
    //
    // La reserva recién se guarda en Firebase (saveReservation) cuando
    // el cliente presiona ESE botón de confirmación. Así, si se le va
    // la luz/internet antes de confirmar, no queda ninguna reserva a
    // medias dando vueltas en la base de datos: el carrito sigue
    // intacto y puede reintentar cuando quiera.
    const CART_STORAGE_KEY = 'arzotrans_cart';
    const HOLD_MINUTES = 20;
    let cart = [];

    try {
        const saved = localStorage.getItem(CART_STORAGE_KEY);
        cart = saved ? JSON.parse(saved) : [];
    } catch (err) {
        cart = [];
    }

    const cartOverlay = document.getElementById('cartOverlay');
    const cartModalHeader = document.querySelector('.cart-modal-header');
    const cartModalTitle = document.getElementById('cartModalTitle');
    const cartBackBtn = document.getElementById('cartBackBtn');
    const cartStepItems = document.getElementById('cartStepItems');
    const cartStepCheckout = document.getElementById('cartStepCheckout');
    const cartBody = document.getElementById('cartBody');
    const cartFooter = document.getElementById('cartFooter');
    const cartCheckoutFooter = document.getElementById('cartCheckoutFooter');
    const cartTotalEl = document.getElementById('cartTotal');
    const cartCheckoutBtn = document.getElementById('cartCheckoutBtn');
    const cartContinueBtn = document.getElementById('cartContinueBtn');
    const cartClearBtn = document.getElementById('cartClearBtn');
    const cartCloseBtn = document.getElementById('cartClose');
    const cartBtnDesktop = document.getElementById('cartBtnDesktop');
    const cartBtnMobile = document.getElementById('cartBtnMobile');
    const cartCountEls = document.querySelectorAll('.cart-count');

    // Nuevo: elementos del paso 3 (confirmación post-WhatsApp)
    const cartCheckoutInitial = document.getElementById('cartCheckoutInitial');
    const cartCheckoutConfirmStep = document.getElementById('cartCheckoutConfirmStep');
    const cartConfirmedBtn = document.getElementById('cartConfirmedBtn');
    const cartNotConfirmedBtn = document.getElementById('cartNotConfirmedBtn');

    const deliveryOptionBtns = document.querySelectorAll('.delivery-option');
    const deliveryError = document.getElementById('deliveryError');
    const checkoutNombre = document.getElementById('checkoutNombre');
    const checkoutNombreError = document.getElementById('checkoutNombreError');
    const checkoutCelular = document.getElementById('checkoutCelular');
    const checkoutCelularError = document.getElementById('checkoutCelularError');
    const checkoutCountryCode = document.getElementById('checkoutCountryCode');
    const checkoutComentarios = document.getElementById('checkoutComentarios');
    const checkoutFecha = document.getElementById('checkoutFecha');
    const checkoutFechaError = document.getElementById('checkoutFechaError');
    const cartSubmitError = document.getElementById('cartSubmitError');

    let selectedDelivery = null;
    // ID corto generado al abrir WhatsApp, se guarda junto a la reserva
    // recién cuando el cliente confirma el envío (ver cartConfirmedBtn).
    let pendingReservationShortId = null;

    const emptyCartHTML = `
        <div class="cart-empty">
            <div class="cart-empty-icon">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4Z"/>
                    <path d="M3 6h18"/>
                    <path d="M16 10a4 4 0 01-8 0"/>
                </svg>
            </div>
            <p class="cart-empty-title">Aún no tienes boletos</p>
            <p class="cart-empty-sub">Agrega alguna ruta para comenzar tu compra</p>
        </div>
    `;

    const saveCart = () => {
        try {
            localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
        } catch (err) {
            /* almacenamiento no disponible, seguimos solo en memoria */
        }
    };

    const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));

    const updateCartCount = () => {
        const totalUnits = cart.reduce((sum, item) => sum + item.qty, 0);
        cartCountEls.forEach(el => {
            el.textContent = totalUnits;
            el.style.display = totalUnits > 0 ? 'flex' : 'none';
            el.classList.remove('bump');
            void el.offsetWidth;
            el.classList.add('bump');
        });
    };

    const renderCart = () => {
        if (cart.length === 0) {
            cartBody.innerHTML = emptyCartHTML;
            cartTotalEl.textContent = '$0';
            if (cartContinueBtn) cartContinueBtn.style.display = 'none';
            if (cartClearBtn) cartClearBtn.style.display = 'none';
            return;
        }

        cartBody.innerHTML = cart.map(item => `
            <div class="cart-item" data-id="${escapeHtml(item.id)}">
                <div class="cart-item-img">
                    ${item.image ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">` : '🚌'}
                </div>
                <div class="cart-item-info">
                    <div class="cart-item-name">${escapeHtml(item.name)}</div>
                    <div class="cart-item-price">$${item.price} c/u</div>
                </div>
                <div class="cart-item-qty">
                    <button type="button" class="cart-qty-btn" data-action="decrease" aria-label="Quitar un pasajero">−</button>
                    <span>${item.qty}</span>
                    <button type="button" class="cart-qty-btn" data-action="increase" aria-label="Agregar un pasajero">+</button>
                </div>
                <button type="button" class="cart-item-remove" data-action="remove" aria-label="Eliminar boleto">&times;</button>
            </div>
        `).join('');

        const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
        cartTotalEl.textContent = `$${total}`;
        if (cartContinueBtn) cartContinueBtn.style.display = '';
        if (cartClearBtn) cartClearBtn.style.display = '';
    };

    const formatTripDate = () => {
        if (!checkoutFecha || !checkoutFecha.value) return '';
        try {
            return new Intl.DateTimeFormat('es', {
                weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            }).format(new Date(checkoutFecha.value));
        } catch (err) {
            return checkoutFecha.value;
        }
    };

    // Ahora recibe el ID corto de la reserva y lo incluye al inicio del
    // mensaje, para que tu equipo pueda ubicarla más rápido en el panel
    // (buscando "A4F2" en vez de tener que buscar por nombre/celular).
    const buildOrderMessage = (shortId) => {
        const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
        const [code, countryName] = checkoutCountryCode.value.split('|');

        let msg = `*NUEVA COMPRA - ARZOTRANS* 🚌\n`;
        if (shortId) msg += `*Boleto #${shortId}*\n`; 
        msg += `\n`;
        cart.forEach(item => {
            msg += `• ${item.name} x${item.qty} - $${item.price * item.qty}\n`;
        });
        msg += `\n*Total: $${total}*\n\n`;
        msg += `*Entrega:* ${selectedDelivery}\n`;
        msg += `*Nombre del pasajero:* ${checkoutNombre.value.trim()}\n`;
        msg += `*Celular:* ${code} ${checkoutCelular.value.trim()} (${countryName})`;
        const fechaTexto = formatTripDate();
        if (fechaTexto) {
            msg += `\n*Fecha y hora del viaje:* ${fechaTexto}`;
        }
        if (checkoutComentarios.value.trim()) {
            msg += `\n*Comentarios del viaje:* ${checkoutComentarios.value.trim()}`;
        }
        return msg;
    };

    const updateCartUI = () => {
        saveCart();
        updateCartCount();
        renderCart();
    };

    // Purga del carrito líneas que ya pasaron el tiempo de retención
    // (HOLD_MINUTES) y devuelve su stock.
    const releaseStaleCartHolds = async () => {
        if (cart.length === 0) return;
        const now = Date.now();
        const staleMs = HOLD_MINUTES * 60 * 1000;
        const stale = cart.filter(item => !item.addedAt || (now - item.addedAt) > staleMs);
        if (stale.length === 0) return;

        for (const item of stale) {
            try {
                await increaseStock(item.id, item.qty, item.addedAt);
            } catch (err) {
                console.error('No se pudo liberar stock retenido para', item.name, err);
            }
        }
        cart = cart.filter(item => item.addedAt && (now - item.addedAt) <= staleMs);
        updateCartUI();

        if (stale.length > 0) {
            setTimeout(() => {
                alert(`Se liberaron ${stale.length} boleto(s) de tu carrito anterior por inactividad (más de ${HOLD_MINUTES} minutos). Podés agregarlos de nuevo si siguen disponibles.`);
            }, 2500);
        }
    };

    const addToCart = async (id, name, price, qty, btnEl, image) => {
        const ok = await decreaseStock(id, qty);
        if (!ok) {
            alert(`No hay suficiente disponibilidad para "${name}".`);
            return false;
        }

        const existing = cart.find(i => i.id === id);
        if (existing) {
            existing.qty += qty;
            existing.addedAt = Date.now();
            if (!existing.image && image) existing.image = image;
        } else {
            cart.push({ id, name, price, qty, image, addedAt: Date.now() });
        }
        updateCartUI();

        if (btnEl) {
            btnEl.classList.add('added');
            setTimeout(() => btnEl.classList.remove('added'), 500);
        }
        if (typeof createConfetti === 'function' && btnEl) {
            createConfetti(btnEl);
        }
        return true;
    };

    // Vuelve el paso 2 (checkout) a su estado inicial: formulario visible,
    // paso de confirmación oculto. Se usa al abrir el carrito de nuevo
    // o al volver del paso de confirmación con "Aún no".
    const resetCheckoutConfirmStep = () => {
        if (cartCheckoutInitial) cartCheckoutInitial.style.display = '';
        if (cartCheckoutConfirmStep) cartCheckoutConfirmStep.style.display = 'none';
        if (cartCheckoutBtn) {
            cartCheckoutBtn.classList.remove('is-loading');
            cartCheckoutBtn.style.pointerEvents = '';
        }
    };

    const showCartStep = (step) => {
        if (step === 'checkout') {
            cartStepItems.classList.remove('active');
            cartStepCheckout.classList.add('active');
            cartFooter.classList.remove('active');
            cartCheckoutFooter.classList.add('active');
            cartModalHeader.classList.add('step-checkout');
            cartModalTitle.textContent = '📋 Datos del pasajero';
            resetCheckoutConfirmStep();
        } else {
            cartStepCheckout.classList.remove('active');
            cartStepItems.classList.add('active');
            cartCheckoutFooter.classList.remove('active');
            cartFooter.classList.add('active');
            cartModalHeader.classList.remove('step-checkout');
            cartModalTitle.textContent = '🚌 Mis Boletos';
        }
    };

    const openCart = () => {
        showCartStep('items');
        cartOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    };

    const closeCart = () => {
        cartOverlay.classList.remove('active');
        document.body.style.overflow = '';
    };

    // Botones "+" del catálogo → abren la vista rápida en vez de añadir directo
    document.querySelectorAll('.btn-add-cart').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.catalog-item, .featured-slide');
            const imgWrap = card ? card.querySelector('.card-img-wrap') : null;
            if (imgWrap) imgWrap.click();
        });
    });

    [cartBtnDesktop, cartBtnMobile].forEach(btn => {
        if (btn) btn.addEventListener('click', openCart);
    });

    if (cartCloseBtn) cartCloseBtn.addEventListener('click', closeCart);
    if (cartOverlay) {
        cartOverlay.addEventListener('click', (e) => {
            if (e.target === cartOverlay) closeCart();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && cartOverlay.classList.contains('active')) closeCart();
    });

    cartBody.addEventListener('click', async (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (!actionBtn) return;
        const itemRow = actionBtn.closest('.cart-item');
        if (!itemRow) return;
        const id = itemRow.getAttribute('data-id');
        const item = cart.find(i => i.id === id);
        if (!item) return;

        const action = actionBtn.getAttribute('data-action');
        if (action === 'increase') {
            const ok = await decreaseStock(id, 1);
            if (!ok) { alert(`No hay más disponibilidad para "${item.name}".`); return; }
            item.qty += 1;
            item.addedAt = Date.now();
        } else if (action === 'decrease') {
            item.qty -= 1;
            await increaseStock(id, 1, item.addedAt);
            if (item.qty <= 0) {
                cart = cart.filter(i => i.id !== id);
            }
        } else if (action === 'remove') {
            await increaseStock(id, item.qty, item.addedAt);
            cart = cart.filter(i => i.id !== id);
        }
        updateCartUI();
    });

    if (cartClearBtn) {
        cartClearBtn.addEventListener('click', async () => {
            for (const item of cart) {
                await increaseStock(item.id, item.qty, item.addedAt);
            }
            cart = [];
            updateCartUI();
        });
    }

    if (cartContinueBtn) {
        cartContinueBtn.addEventListener('click', () => {
            if (cart.length === 0) return;
            showCartStep('checkout');
        });
    }

    if (cartBackBtn) {
        cartBackBtn.addEventListener('click', () => showCartStep('items'));
    }

    deliveryOptionBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            deliveryOptionBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedDelivery = btn.getAttribute('data-delivery');
            if (deliveryError) deliveryError.style.display = 'none';
        });
    });

    const PHONE_LENGTH_BY_CODE = {
        '+57': [10, 10], '+52': [10, 10], '+54': [10, 11], '+51': [9, 9],
        '+58': [10, 10], '+56': [9, 9], '+502': [8, 8], '+593': [9, 9],
        '+591': [8, 8], '+1': [10, 10], '+504': [8, 8], '+595': [9, 9],
        '+598': [8, 9], '+503': [8, 8], '+505': [8, 8], '+507': [7, 8],
        '+506': [8, 8], '+55': [10, 11], '+34': [9, 9], '+351': [9, 9],
        '+244': [9, 9], '+258': [9, 9], '+66': [9, 9], '+84': [9, 10],
        '+60': [9, 10], '+62': [9, 12], '+63': [10, 10],
    };

    const isValidPhoneForCountry = (digits, countryCode) => {
        const range = PHONE_LENGTH_BY_CODE[countryCode];
        if (!range) return digits.length >= 7;
        const [min, max] = range;
        return digits.length >= min && digits.length <= max;
    };

    const setFieldError = (inputEl, errorEl, hasError) => {
        if (inputEl) inputEl.classList.toggle('input-error', hasError);
        if (errorEl) errorEl.style.display = hasError ? 'block' : 'none';
    };

    if (checkoutNombre) {
        checkoutNombre.addEventListener('input', () => {
            if (checkoutNombre.classList.contains('input-error') && checkoutNombre.value.trim().length >= 3) {
                setFieldError(checkoutNombre, checkoutNombreError, false);
            }
        });
    }
    if (checkoutCelular) {
        checkoutCelular.addEventListener('input', () => {
            if (checkoutCelular.classList.contains('input-error')) {
                const digits = checkoutCelular.value.replace(/\D/g, '');
                const [code] = checkoutCountryCode.value.split('|');
                if (isValidPhoneForCountry(digits, code)) setFieldError(checkoutCelular, checkoutCelularError, false);
            }
        });
    }
    if (checkoutCountryCode) {
        checkoutCountryCode.addEventListener('change', () => {
            if (checkoutCelular.classList.contains('input-error')) {
                const digits = checkoutCelular.value.replace(/\D/g, '');
                const [code] = checkoutCountryCode.value.split('|');
                setFieldError(checkoutCelular, checkoutCelularError, !isValidPhoneForCountry(digits, code));
            }
        });
    }
    if (checkoutFecha) {
        checkoutFecha.addEventListener('change', () => {
            if (checkoutFecha.classList.contains('input-error') && checkoutFecha.value) {
                setFieldError(checkoutFecha, checkoutFechaError, false);
            }
        });
    }

    // ────────────────────────────────────────────────────────────
    // PASO 1 del envío: validar datos, generar el ID corto de la
    // reserva (verificado como único contra Firebase), abrir WhatsApp
    // (con ese ID ya incluido en el mensaje) y mostrar el paso de
    // confirmación. TODAVÍA NO se guarda nada en Firebase (la reserva
    // en sí, más allá del registro del código corto).
    // ────────────────────────────────────────────────────────────
    if (cartCheckoutBtn) {
        cartCheckoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            let isValid = true;

            [deliveryError, checkoutNombreError, checkoutCelularError, checkoutFechaError].forEach(el => {
                if (el) el.style.display = 'none';
            });
            [checkoutNombre, checkoutCelular, checkoutFecha].forEach(el => {
                if (el) el.classList.remove('input-error');
            });
            if (cartSubmitError) cartSubmitError.style.display = 'none';

            if (!selectedDelivery) {
                isValid = false;
                if (deliveryError) deliveryError.style.display = 'block';
            }

            if (checkoutNombre.value.trim().length < 3) {
                isValid = false;
                setFieldError(checkoutNombre, checkoutNombreError, true);
            }

            const phoneDigits = checkoutCelular.value.replace(/\D/g, '');
            const [countryCode] = checkoutCountryCode.value.split('|');
            if (!isValidPhoneForCountry(phoneDigits, countryCode)) {
                isValid = false;
                setFieldError(checkoutCelular, checkoutCelularError, true);
            }

            if (checkoutFecha && !checkoutFecha.value) {
                isValid = false;
                setFieldError(checkoutFecha, checkoutFechaError, true);
            }

            if (!isValid) return;

            // Mostramos un estado de carga breve mientras verificamos que
            // el código no esté repetido (suele tardar bien poco).
            cartCheckoutBtn.classList.add('is-loading');
            cartCheckoutBtn.style.pointerEvents = 'none';

            // Generamos el ID corto de esta reserva (verificado como único
            // contra Firebase) y lo incluimos en el mensaje de WhatsApp
            // desde ya, para que el cliente lo tenga visible en el chat
            // aunque nunca vuelva a abrir el sitio.
            pendingReservationShortId = await generateUniqueShortId();

            cartCheckoutBtn.classList.remove('is-loading');
            cartCheckoutBtn.style.pointerEvents = '';

            const msg = buildOrderMessage(pendingReservationShortId);
            window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`, '_blank');

            // Mostramos el paso 3: "¿Ya enviaste el mensaje?"
            if (cartCheckoutInitial) cartCheckoutInitial.style.display = 'none';
            if (cartCheckoutConfirmStep) cartCheckoutConfirmStep.style.display = 'block';
        });
    }

    // ────────────────────────────────────────────────────────────
    // PASO 2 del envío: el cliente confirma que SÍ mandó el mensaje.
    // Recién ACÁ se guarda la reserva en Firebase (con su ID corto) y
    // se vacía el carrito. También activamos el "watcher" que va a
    // avisarle al cliente si el estado de esta reserva cambia más
    // adelante (Confirmada/Cancelada), mientras tenga el sitio abierto,
    // y va a dejar marcado el ícono de historial si no lo tiene abierto.
    // Si el cliente nunca llega a este paso (se le va la luz/internet,
    // cierra la pestaña), no queda ninguna reserva a medias: el carrito
    // sigue intacto para reintentar más tarde.
    // ────────────────────────────────────────────────────────────
    if (cartConfirmedBtn) {
        cartConfirmedBtn.addEventListener('click', async () => {
            cartConfirmedBtn.classList.add('is-loading');
            cartConfirmedBtn.style.pointerEvents = 'none';
            if (cartSubmitError) cartSubmitError.style.display = 'none';

            try {
                const reservationId = await saveReservation(pendingReservationShortId);
                addMyReservationId(reservationId);
                setSeenStatus(reservationId, 'pendiente');
                attachReservationWatcher(reservationId);
                updateHistoryCount();
                pendingReservationShortId = null;

                // El stock ya fue descontado al momento de agregar cada
                // boleto al carrito, así que aquí solo vaciamos el carrito.
                cart = [];
                updateCartUI();
                closeCart();
            } catch (err) {
                console.error('Error al guardar la reserva:', err);
                if (cartSubmitError) {
                cartSubmitError.textContent = 'No pudimos procesar tu compra (revisá tu conexión). Tu carrito sigue intacto, volvé a presionar "Ya confirmé" para reintentar.';
                cartSubmitError.style.display = 'block';
                } else {
                   alert('No pudimos procesar tu compra. Tu carrito sigue intacto, intentá de nuevo.');
                }
            } finally {
                cartConfirmedBtn.classList.remove('is-loading');
                cartConfirmedBtn.style.pointerEvents = '';
            }
        });
    }

    // "Aún no" → vuelve al botón de WhatsApp por si quiere reabrir el
    // chat o revisar los datos antes de confirmar.
    if (cartNotConfirmedBtn) {
        cartNotConfirmedBtn.addEventListener('click', () => {
            resetCheckoutConfirmStep();
        });
    }

    // ════════════════════════════════════════════
    // 🔍 15. QUICK VIEW POR RUTA/SERVICIO (click/toque en la imagen)
    // ════════════════════════════════════════════
    const qvOverlay = document.getElementById('quickviewOverlay');
    const qvClose = document.getElementById('quickviewClose');
    const qvTitle = document.getElementById('qvTitle');
    const qvImage = document.getElementById('qvImage');
    const qvPrice = document.getElementById('qvPrice');
    const qvQtyValue = document.getElementById('qvQtyValue');
    const qvDecrease = document.getElementById('qvDecrease');
    const qvIncrease = document.getElementById('qvIncrease');
    const qvAddBtn = document.getElementById('qvAddBtn');
    const qvAddPrice = document.getElementById('qvAddPrice');
    const qvModal = document.querySelector('.quickview-modal');

    let qvCurrentProduct = null;
    let qvQty = 1;

    const updateQvAddPrice = () => {
        qvQtyValue.textContent = qvQty;
        if (qvCurrentProduct) {
            qvAddPrice.textContent = `$${qvCurrentProduct.price * qvQty}`;
        }
    };

      if (qvOverlay) {
        document.querySelectorAll('.catalog-item .card-img-wrap, .featured-slide .card-img-wrap').forEach(imgWrap => {
            imgWrap.style.cursor = 'pointer';
            imgWrap.addEventListener('click', () => {
                const card = imgWrap.closest('.catalog-item, .featured-slide');
                if (qvModal) qvModal.classList.toggle('qv-featured', card.classList.contains('featured-slide'));
                const btn = card.querySelector('.btn-add-cart');
                const id = btn.getAttribute('data-id') || btn.getAttribute('data-item');
                const name = btn.getAttribute('data-item');
                const price = parseFloat(btn.getAttribute('data-price')) || 0;
                const imgEl = imgWrap.querySelector('img');
                const imageSrc = imgEl.getAttribute('src');

                qvCurrentProduct = { id, name, price, image: imageSrc };
                qvQty = 1;

                qvTitle.textContent = name;
                qvImage.src = imageSrc;
                qvImage.alt = imgEl.getAttribute('alt') || name;
                qvPrice.textContent = `$${price}`;
                updateQvAddPrice();

                qvOverlay.classList.add('active');
                document.body.style.overflow = 'hidden';
                updateQvStockDisplay();
            });
        });

        const closeQv = () => {
            qvOverlay.classList.remove('active');
            document.body.style.overflow = '';
        };

        if (qvClose) qvClose.addEventListener('click', closeQv);
        qvOverlay.addEventListener('click', (e) => {
            if (e.target === qvOverlay) closeQv();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && qvOverlay.classList.contains('active')) closeQv();
        });

        qvDecrease.addEventListener('click', () => {
            if (qvQty > 1) qvQty--;
            updateQvAddPrice();
            updateQvStockDisplay();
        });
        qvIncrease.addEventListener('click', () => {
            const stock = getStock(qvCurrentProduct.id);
            if (qvQty + 1 > stock) {
                alert(`Solo quedan ${Math.max(stock, 0)} disponible(s) para "${qvCurrentProduct.name}".`);
                return;
            }
            qvQty++;
            updateQvAddPrice();
            updateQvStockDisplay();
        });

        qvAddBtn.addEventListener('click', async () => {
            if (!qvCurrentProduct) return;
            const ok = await addToCart(qvCurrentProduct.id, qvCurrentProduct.name, qvCurrentProduct.price, qvQty, qvAddBtn, qvCurrentProduct.image);
            if (ok) closeQv();
        });
    }

    // 16. CONFETI (Pure DOM - CSS Animated)
    const confetiTriggers = document.querySelectorAll('.cta-confetti-trigger');
    confetiTriggers.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            createConfetti(btn);
            const href = btn.getAttribute('href');
            setTimeout(() => {
                if (href) window.open(href, '_blank');
            }, 800);
        });
    });

    function createConfetti(element) {
        const container = document.getElementById('confetti-container');
        const colors = ['#1B4332', '#74C69D', '#E8A0B0', '#FEF0F3', '#C5A028'];
        for (let i = 0; i < 50; i++) {
            const petal = document.createElement('div');
            petal.classList.add('petal-confetti');
            petal.style.background = colors[Math.floor(Math.random() * colors.length)];
            petal.style.left = Math.random() * 100 + 'vw';
            petal.style.animationDuration = (Math.random() * 2 + 2) + 's';
            petal.style.animationDelay = (Math.random() * 0.5) + 's';
            container.appendChild(petal);
            setTimeout(() => petal.remove(), 4000);
        }
    }

    // ════════════════════════════════════════════
    // 🔎 17. BUSCADOR DE RUTAS (con debounce)
    // ════════════════════════════════════════════
    const searchForms = document.querySelectorAll('[data-search-form]');
    const searchInputs = document.querySelectorAll('.nav-search-input');
    const noResultsMsg = document.getElementById('noResults');
    const normalizeText = (str) => str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const performSearch = (rawQuery) => {
        searchInputs.forEach(input => {
            if (input.value !== rawQuery) input.value = rawQuery;
        });

        const query = normalizeText(rawQuery.trim());
        if (categoryEmptyMsg) categoryEmptyMsg.style.display = 'none';

        if (!query) {
            applyFilter('all');
            if (noResultsMsg) noResultsMsg.style.display = 'none';
            return;
        }

        filterBtns.forEach(b => b.classList.remove('active'));
        catalogItems.forEach(item => {
            item.style.opacity = '0';
            item.style.transform = 'scale(0.9)';
        });

        setTimeout(() => {
            let matches = 0;
            catalogItems.forEach(item => {
                const name = normalizeText(item.querySelector('h3').textContent);
                if (name.includes(query)) {
                    item.classList.remove('hidden');
                    void item.offsetWidth;
                    item.style.opacity = '1';
                    item.style.transform = 'scale(1)';
                    matches++;
                } else {
                    item.classList.add('hidden');
                }
            });
            if (noResultsMsg) noResultsMsg.style.display = matches === 0 ? 'block' : 'none';
        }, 300);
    };

    const performSearchAndScroll = (rawQuery) => {
        performSearch(rawQuery);
        const catalogSection = document.getElementById('rutas');
        if (catalogSection) catalogSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (navList) navList.classList.remove('active');
    };

    const debouncedSearch = debounce(performSearch, 250);

    searchForms.forEach(form => {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = form.querySelector('.nav-search-input');
            performSearchAndScroll(input.value);
        });
    });

    searchInputs.forEach(input => {
        input.addEventListener('input', () => debouncedSearch(input.value));
    });

    // ════════════════════════════════════════════
    // 🔽 18. ORDENAR CATÁLOGO (Ordenar por)
    // ════════════════════════════════════════════
    const sortToggleBtn = document.getElementById('sortToggleBtn');
    const sortDropdown = document.getElementById('sortDropdown');
    const sortOptions = document.querySelectorAll('.sort-option');
    const sortLabel = document.getElementById('sortLabel');
    const catalogGridEl = document.getElementById('catalogGrid');
    const normalizeForSort = (str) => str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (catalogGridEl) {
        Array.from(catalogGridEl.querySelectorAll('.catalog-item')).forEach((item, idx) => {
            item.setAttribute('data-order', idx);
        });
    }

    const getItemName = (item) => normalizeForSort(item.querySelector('h3').textContent.trim());
    const getItemPrice = (item) => parseFloat(item.querySelector('.btn-add-cart').getAttribute('data-price')) || 0;

    const sortCatalog = (type) => {
        if (!catalogGridEl) return;
        const items = Array.from(catalogGridEl.querySelectorAll('.catalog-item'));
        let sorted;
        switch (type) {
            case 'az': sorted = items.sort((a, b) => getItemName(a).localeCompare(getItemName(b))); break;
            case 'price-asc': sorted = items.sort((a, b) => getItemPrice(a) - getItemPrice(b)); break;
            case 'price-desc': sorted = items.sort((a, b) => getItemPrice(b) - getItemPrice(a)); break;
            case 'newest': sorted = items.sort((a, b) => parseInt(b.getAttribute('data-order')) - parseInt(a.getAttribute('data-order'))); break;
            default: sorted = items.sort((a, b) => parseInt(a.getAttribute('data-order')) - parseInt(b.getAttribute('data-order')));
        }
        sorted.forEach(item => catalogGridEl.appendChild(item));
    };

    if (sortToggleBtn && sortDropdown) {
        sortToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            sortDropdown.classList.toggle('active');
            sortToggleBtn.classList.toggle('active');
        });
        document.addEventListener('click', (e) => {
            if (!sortDropdown.contains(e.target) && !sortToggleBtn.contains(e.target)) {
                sortDropdown.classList.remove('active');
                sortToggleBtn.classList.remove('active');
            }
        });
        sortOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                sortOptions.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                sortLabel.textContent = opt.textContent;
                sortCatalog(opt.getAttribute('data-sort'));
                sortDropdown.classList.remove('active');
                sortToggleBtn.classList.remove('active');
            });
        });
    }

    // ════════════════════════════════════════════
    // 📦 20. DISPONIBILIDAD (STOCK) POR PRODUCTO — EN TIEMPO REAL (Firebase)
    // ════════════════════════════════════════════
    const DEFAULT_STOCK = 5;
    const ADMIN_PASSWORD = atob('YXJ6b3RyYW5zMjAyNQ==');

    let stockData = {};
    const stockBadgeRegistry = {};

    // Se registran tanto las tarjetas del catálogo como las del carrusel
    // de Destacados: comparten exactamente el mismo sistema de stock,
    // insignia de asientos y vista rápida (Quick View).
    document.querySelectorAll('.catalog-item, .featured-slide').forEach(item => {
        const btn = item.querySelector('.btn-add-cart');
        const content = item.querySelector('.card-content, .featured-info');
        if (!btn || !content) return;
        const id = btn.getAttribute('data-id') || btn.getAttribute('data-item');
        const name = btn.getAttribute('data-item');
        const badge = document.createElement('div');
        badge.className = 'stock-badge stock-badge-loading';
        badge.textContent = 'Verificando asientos…';
        btn.disabled = true;
        const footerRef = content.querySelector('.card-footer');
        if (footerRef) {
            content.insertBefore(badge, footerRef);
        } else {
            content.appendChild(badge);
        }
        if (!stockBadgeRegistry[id]) stockBadgeRegistry[id] = [];
        stockBadgeRegistry[id].push({ card: item, badge, btn, name });
    });
    const getStock = (id) => (stockData[id] !== undefined) ? stockData[id] : DEFAULT_STOCK;

    const qvStockEl = document.getElementById('qvStock');
    const updateQvStockDisplay = () => {
        if (!qvCurrentProduct || !qvStockEl) return;
        const stock = getStock(qvCurrentProduct.id);
        qvStockEl.textContent = stock > 0 ? `Boletos Disponibles: ${stock}` : 'Sin disponibilidad (agotado)';
        qvStockEl.classList.toggle('stock-out', stock <= 0);
        if (qvAddBtn) qvAddBtn.disabled = stock <= 0;
        if (qvIncrease) qvIncrease.disabled = stock <= 0;
    };

        const refreshStockUI = (id) => {
        const stock = getStock(id);
        (stockBadgeRegistry[id] || []).forEach(({ card, badge, btn }) => {
            badge.classList.remove('stock-badge-loading');
            badge.textContent = stock > 0 ? `Boletos Disponibles: ${stock}` : 'Agotado';
            badge.classList.toggle('stock-out', stock <= 0);
            badge.classList.toggle('stock-low', stock > 0 && stock <= 2);
            card.classList.toggle('sold-out', stock <= 0);
            btn.disabled = stock <= 0;
        });
        if (qvCurrentProduct && qvCurrentProduct.id === id) updateQvStockDisplay();
    };

    // Fija el stock de una ruta a un valor absoluto y registra el
    // momento exacto de este reset en stockMeta. Cualquier asiento que
    // ya estuviera en el carrito de un cliente ANTES de este momento
    // no debe poder "devolverse" y sumarse por encima de este valor:
    // ver increaseStock() más abajo, que consulta este timestamp.
    const setStock = (id, value) => {
        const v = Math.max(0, Math.round(value));
        const key = encodeStockKey(id);
        return stockRef.child(key).set(v)
            .then(() => stockMetaRef.child(key).set(Date.now()).catch(() => {
                /* si falla el registro del timestamp no bloqueamos el reset del stock */
            }))
            .catch(err => { console.error('Error al fijar stock:', err); throw err; });
    };

    const decreaseStock = (id, qty) => {
        const key = encodeStockKey(id);
        return stockRef.child(key).transaction(current => {
            const currentVal = (current === null || current === undefined) ? DEFAULT_STOCK : current;
            if (currentVal < qty) {
                return; // aborta la transacción (undefined = no cambiar nada)
            }
            return currentVal - qty;
        }).then(result => {
            if (result.committed) {
                logStockActivity(id, qty);
                return true;
            }
            return false;
        }).catch(err => {
            console.error('Error en la transacción de stock:', err);
            return false;
        });
    };

    // Devuelve stock cuando un cliente saca algo del carrito, lo vacía,
    // o se le vence el hold por inactividad.
    //
    // itemAddedAt es el timestamp (Date.now()) de cuando ESE asiento se
    // agregó al carrito del cliente. Antes de sumar, chequeamos si el
    // admin restableció el stock DESPUÉS de ese momento: si es así, esa
    // reserva ya "no existe" desde el punto de vista del admin (el reset
    // pisó todo), así que no la devolvemos — evita que el número final
    // termine más alto que el valor que el admin fijó a propósito.
    const increaseStock = async (id, qty, itemAddedAt) => {
        const key = encodeStockKey(id);

        if (itemAddedAt) {
            try {
                const metaSnap = await stockMetaRef.child(key).once('value');
                const resetAt = metaSnap.val();
                if (resetAt && resetAt > itemAddedAt) {
                    // Hubo un restablecimiento de stock posterior a que este
                    // asiento se agregara al carrito: no se devuelve, para
                    // respetar el número que el admin fijó.
                    return;
                }
            } catch (err) {
                // Si no se pudo leer stockMeta, preferimos devolver el
                // asiento (mejor sumar de más en un caso raro que perder
                // disponibilidad real para los clientes).
            }
        }

        return stockRef.child(key).transaction(current => {
            const currentVal = (current === null || current === undefined) ? DEFAULT_STOCK : current;
            return currentVal + qty;
        }).catch(err => {
            console.error('Error al liberar stock:', err);
        });
    };

    // Mantiene los números del panel de admin sincronizados en vivo,
    // sin pisar lo que el admin esté escribiendo en ese momento.
    const refreshStockAdminRows = () => {
        if (!stockAdminList) return;
        stockAdminList.querySelectorAll('.stockadmin-row').forEach(row => {
            const id = row.getAttribute('data-id');
            const input = row.querySelector('.stockadmin-input');
            if (input && document.activeElement !== input) {
                input.value = getStock(id);
            }
        });
    };

    stockRef.on('value', (snapshot) => {
        const val = snapshot.val() || {};
        Object.keys(stockBadgeRegistry).forEach(id => {
            const key = encodeStockKey(id);
            stockData[id] = (val[key] !== undefined) ? val[key] : DEFAULT_STOCK;
            refreshStockUI(id);
        });
        refreshStockAdminRows();
    }, (err) => {
        console.error('No se pudo escuchar el stock en tiempo real:', err);
    });

    releaseStaleCartHolds().finally(() => updateCartUI());

    // Panel de administración (5 clics en el copyright del footer)
    const footerCopy = document.getElementById('footerCopyright');
    let adminClickCount = 0;
    let adminClickTimer = null;
    if (footerCopy) {
        footerCopy.addEventListener('click', () => {
            adminClickCount++;
            clearTimeout(adminClickTimer);
            adminClickTimer = setTimeout(() => { adminClickCount = 0; }, 2000);
            if (adminClickCount >= 5) {
                adminClickCount = 0;
                const pass = prompt('Ingresa la clave de administrador:');
                if (pass === ADMIN_PASSWORD) openStockAdmin();
                else if (pass !== null) alert('Clave incorrecta.');
            }
        });
    }

    const stockAdminOverlay = document.getElementById('stockAdminOverlay');
    const stockAdminClose = document.getElementById('stockAdminClose');
    const stockAdminList = document.getElementById('stockAdminList');
    const stockAdminSearch = document.getElementById('stockAdminSearch');
    const stockAdminDefaultValue = document.getElementById('stockAdminDefaultValue');
    const stockAdminResetAllBtn = document.getElementById('stockAdminResetAllBtn');

    const renderStockAdminList = async (filter = '') => {
        if (!stockAdminList) return;
        const q = normalizeText(filter.trim());
        const ids = Object.keys(stockBadgeRegistry).filter(id => {
            const name = stockBadgeRegistry[id][0]?.name || id;
            return normalizeText(name).includes(q);
        }).sort((a, b) => (stockBadgeRegistry[a][0]?.name || a).localeCompare(stockBadgeRegistry[b][0]?.name || b));

        stockAdminList.innerHTML = ids.map(id => {
            const name = stockBadgeRegistry[id][0]?.name || id;
            return `
            <div class="stockadmin-row" data-id="${escapeHtml(id)}">
                <span class="stockadmin-name">
                    ${escapeHtml(name)}
                    <span class="stockadmin-activity" data-activity-for="${escapeHtml(id)}">cargando actividad…</span>
                </span>
                <div class="stockadmin-controls">
                    <button type="button" class="stockadmin-btn" data-act="dec">−</button>
                    <input type="number" class="stockadmin-input" min="0" value="${getStock(id)}">
                    <button type="button" class="stockadmin-btn" data-act="inc">+</button>
                </div>
            </div>
        `;
        }).join('') || '<p class="stockadmin-empty">No se encontraron rutas.</p>';

        const YESTERDAY = Date.now() - (24 * 60 * 60 * 1000);
        ids.forEach(async (id) => {
            const key = encodeStockKey(id);
            try {
                const snap = await activityRef.child(key).once('value');
                const val = snap.val() || {};
                let totalUnidades = 0;
                let totalEventos = 0;
                Object.values(val).forEach(entry => {
                    if (entry.ts && entry.ts >= YESTERDAY) {
                        totalUnidades += (entry.qty || 1);
                        totalEventos++;
                    }
                });
                const badge = stockAdminList.querySelector(`[data-activity-for="${CSS.escape(id)}"]`);
                if (badge) {
                    badge.textContent = totalEventos > 0
                        ? `📈 ${totalUnidades} agregado(s) en las últimas 24h`
                        : `Sin actividad en las últimas 24h`;
                    badge.classList.toggle('has-activity', totalEventos > 0);
                }
            } catch (err) {
                const badge = stockAdminList.querySelector(`[data-activity-for="${CSS.escape(id)}"]`);
                if (badge) badge.textContent = '';
            }
        });
    };

    const openStockAdmin = async () => {
        if (!stockAdminOverlay) return;
        await renderStockAdminList(stockAdminSearch ? stockAdminSearch.value : '');
        stockAdminOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    };

    const closeStockAdmin = () => {
        if (!stockAdminOverlay) return;
        stockAdminOverlay.classList.remove('active');
        document.body.style.overflow = '';
    };

    if (stockAdminClose) stockAdminClose.addEventListener('click', closeStockAdmin);
    if (stockAdminOverlay) stockAdminOverlay.addEventListener('click', (e) => { if (e.target === stockAdminOverlay) closeStockAdmin(); });
    if (stockAdminSearch) stockAdminSearch.addEventListener('input', () => renderStockAdminList(stockAdminSearch.value));
    if (stockAdminList) {
        stockAdminList.addEventListener('click', (e) => {
            const btn = e.target.closest('.stockadmin-btn');
            if (!btn) return;
            const row = btn.closest('.stockadmin-row');
            const id = row.getAttribute('data-id');
            const input = row.querySelector('.stockadmin-input');
            let value = (parseInt(input.value, 10) || 0) + (btn.getAttribute('data-act') === 'inc' ? 1 : -1);
            value = Math.max(0, value);
            input.value = value;
            setStock(id, value).catch(() => alert('No se pudo actualizar el stock. Revisá tu conexión.'));
        });
        stockAdminList.addEventListener('change', (e) => {
            const input = e.target.closest('.stockadmin-input');
            if (!input) return;
            const row = input.closest('.stockadmin-row');
            setStock(row.getAttribute('data-id'), parseInt(input.value, 10) || 0)
                .catch(() => alert('No se pudo actualizar el stock. Revisá tu conexión.'));
        });
    }
        if (stockAdminResetAllBtn) {
        stockAdminResetAllBtn.addEventListener('click', async () => {
            const val = Math.max(0, parseInt(stockAdminDefaultValue.value, 10) || 0);
            const ok = await showConfirm('Restablecer disponibilidad', `¿Restablecer la disponibilidad de TODAS las rutas a ${val}?`);
            if (!ok) return;
            Object.keys(stockBadgeRegistry).forEach(id => setStock(id, val).catch(() => {}));
            renderStockAdminList(stockAdminSearch ? stockAdminSearch.value : '');
        });
    }
    // ════════════════════════════════════════════
    // 📋 21. HISTORIAL DE RESERVAS DEL CLIENTE
    // ════════════════════════════════════════════
    const MY_RESERVATIONS_KEY = 'arzotrans_my_reservations';

    const getMyReservationIds = () => {
        try {
            const ids = JSON.parse(localStorage.getItem(MY_RESERVATIONS_KEY));
            return Array.isArray(ids) ? ids : [];
        } catch (err) {
            return [];
        }
    };

    const setMyReservationIds = (ids) => {
        try {
            localStorage.setItem(MY_RESERVATIONS_KEY, JSON.stringify(ids.slice(0, 200)));
        } catch (err) {
            /* almacenamiento no disponible, no rompe el flujo */
        }
    };

    const addMyReservationId = (id) => {
        if (!id) return;
        const ids = getMyReservationIds();
        ids.unshift(id);
        setMyReservationIds(ids);
    };

    // Guarda la reserva actual (carrito + datos del pasajero + ID corto)
    // en Firebase y devuelve una Promise que resuelve con el id
    // generado (push key), o rechaza si falla el guardado. Se llama
    // SOLO cuando el cliente confirma que envió el WhatsApp (ver
    // cartConfirmedBtn). Si por algún motivo no llega shortId, se
    // genera uno como respaldo (sin verificar unicidad, caso borde).
    const saveReservation = (shortId) => {
        const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
        const [code, countryName] = checkoutCountryCode.value.split('|');

        const reservation = {
            shortId: shortId || generateShortId(),
            items: cart.map(item => ({ id: item.id, name: item.name, price: item.price, qty: item.qty })),
            total,
            delivery: selectedDelivery,
            nombre: checkoutNombre.value.trim(),
            celular: `${code} ${checkoutCelular.value.trim()}`,
            pais: countryName,
            fechaViaje: checkoutFecha ? checkoutFecha.value : '',
            comentarios: checkoutComentarios.value.trim(),
            status: 'pendiente',
            ts: Date.now()
        };

        const newRef = reservationsRef.push();
        return newRef.set(reservation).then(() => newRef.key);
    };

    const STATUS_LABELS = {
        pendiente: { text: 'Pendiente', className: '' },
        confirmada: { text: 'Confirmada', className: 'confirmada' },
        cancelada: { text: 'Cancelada', className: 'cancelada' }
    };

    // Devuelve un ID corto de 4 caracteres para mostrar en pantalla:
    // usa el shortId guardado si existe, o arma uno a partir del final
    // del ID de Firebase (para reservas hechas antes de este cambio).
    const displayShortId = (reservation) => {
        if (reservation && reservation.shortId) return reservation.shortId;
        if (reservation && reservation.id) return reservation.id.slice(-4).toUpperCase();
        return '----';
    };

    const formatReservationDate = (ts) => {
        if (!ts) return '';
        try {
            return new Intl.DateTimeFormat('es', {
                day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
            }).format(new Date(ts));
        } catch (err) {
            return '';
        }
    };

    // ════════════════════════════════════════════
    // 🔔 AVISO DE CAMBIO DE ESTADO (toast + notificación + puntito)
    // ════════════════════════════════════════════
    // Guardamos, por reserva, cuál fue el último estado que el cliente
    // "vio" (o que ya conocemos localmente). Cuando Firebase nos avisa
    // que el estado cambió respecto al guardado, disparamos el aviso.
    const STATUS_SEEN_KEY = 'arzotrans_status_seen';
    const HISTORY_ALERT_KEY = 'arzotrans_history_alert';

    const getSeenStatuses = () => {
        try { return JSON.parse(localStorage.getItem(STATUS_SEEN_KEY)) || {}; }
        catch (err) { return {}; }
    };
    const setSeenStatus = (id, status) => {
        try {
            const map = getSeenStatuses();
            map[id] = status;
            localStorage.setItem(STATUS_SEEN_KEY, JSON.stringify(map));
        } catch (err) { /* sin storage disponible */ }
    };

    const markHistoryAlert = (on) => {
        document.querySelectorAll('.nav-history-btn').forEach(btn => btn.classList.toggle('has-alert', on));
        try { localStorage.setItem(HISTORY_ALERT_KEY, on ? '1' : '0'); } catch (err) { /* sin storage */ }
    };

    const showStatusToast = (message) => {
        const toast = document.createElement('div');
        toast.className = 'status-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('active'));
        setTimeout(() => {
            toast.classList.remove('active');
            setTimeout(() => toast.remove(), 400);
        }, 5000);
    };

    const notifyStatusChange = (reservation) => {
        const status = STATUS_LABELS[reservation.status] || STATUS_LABELS.pendiente;
        const shortId = displayShortId(reservation);
        const message = `Boleto #${shortId}: ahora está "${status.text}"`;
        showStatusToast(`🚌 ${message}`);
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                new Notification('Arzotrans - Actualización de tu boleto', {
                    body: message,
                    icon: 'Imagenes/isologo.png'
                });
            } catch (err) { /* algunos navegadores/entornos bloquean new Notification() */ }
        }
        markHistoryAlert(true);
    };

    // Escucha en vivo los cambios de UNA reserva puntual y dispara el
    // aviso cuando el status cambia respecto al último que teníamos
    // guardado localmente. Se llama al confirmar una reserva nueva y
    // también, al cargar la página, para todas las reservas ya
    // guardadas del cliente (ver attachGlobalReservationWatchers).
    const reservationWatchers = {};
    const attachReservationWatcher = (id) => {
        if (!id || reservationWatchers[id]) return; // evita duplicar listeners
        const handler = (snap) => {
            const val = snap.val();
            if (!val) return;
            const seen = getSeenStatuses();
            const prev = seen[id];
            if (prev !== undefined && prev !== val.status) {
                notifyStatusChange({ ...val, id });
            }
            setSeenStatus(id, val.status);
        };
        reservationsRef.child(id).on('value', handler);
        reservationWatchers[id] = handler;
    };

    const attachGlobalReservationWatchers = () => {
        getMyReservationIds().forEach(attachReservationWatcher);
    };

    const historyBtnMobile = document.getElementById('historyBtnMobile');
    const historyBtnDesktop = document.getElementById('historyBtnDesktop');
    const historyCountEls = document.querySelectorAll('.history-count');
    const historyOverlay = document.getElementById('historyOverlay');
    const historyClose = document.getElementById('historyClose');
    const historyBody = document.getElementById('historyBody');
    const historyClearBtn = document.getElementById('historyClearBtn');
    const historyNotifyBtn = document.getElementById('historyNotifyBtn');

    const updateNotifyBtnState = () => {
        if (!historyNotifyBtn) return;
        if (!('Notification' in window)) { historyNotifyBtn.style.display = 'none'; return; }
        const granted = Notification.permission === 'granted';
        historyNotifyBtn.textContent = granted ? '🔔 Avisos activados' : '🔔 Activar avisos';
        historyNotifyBtn.classList.toggle('enabled', granted);
    };

    if (historyNotifyBtn) {
        historyNotifyBtn.addEventListener('click', async () => {
            if (Notification.permission === 'default') {
                await Notification.requestPermission().catch(() => {});
            }
            updateNotifyBtnState();
        });
    }

    const updateHistoryCount = (explicitCount) => {
        const count = (typeof explicitCount === 'number') ? explicitCount : getMyReservationIds().length;
        historyCountEls.forEach(el => {
            el.textContent = count;
            el.style.display = count > 0 ? 'flex' : 'none';
        });
    };

    const emptyHistoryHTML = `<p class="history-empty">Aún no tienes boletos 🚌 Cuando confirmes una compra, aparecerá aquí.</p>`;

    let historyListenerRefs = [];

    const detachHistoryListeners = () => {
        historyListenerRefs.forEach(({ ref, handler }) => ref.off('value', handler));
        historyListenerRefs = [];
    };

       const renderHistory = async () => {
        if (!historyBody) return;
        const ids = getMyReservationIds();

        if (ids.length === 0) {
            historyBody.innerHTML = emptyHistoryHTML;
            updateHistoryCount(0);
            if (historyClearBtn) historyClearBtn.style.display = 'none';
            return;
        }
        if (historyClearBtn) historyClearBtn.style.display = '';

        historyBody.innerHTML = '<p class="stockadmin-empty">Cargando tus boletos…</p>';

        const results = await Promise.all(ids.map(async (id) => {
            try {
                const snap = await reservationsRef.child(id).once('value');
                const val = snap.val();
                return val ? { id, ...val } : null;
            } catch (err) {
                console.error('No se pudo leer la reserva', id, err);
                return { id, error: true };
            }
        }));

        const confirmedMissing = ids.filter((id, i) => results[i] === null);
        if (confirmedMissing.length > 0) {
            const pruned = ids.filter(id => !confirmedMissing.includes(id));
            setMyReservationIds(pruned);
        }

        const valid = results.filter(r => r && !r.error).sort((a, b) => (b.ts || 0) - (a.ts || 0));

        if (valid.length === 0) {
            historyBody.innerHTML = emptyHistoryHTML;
            updateHistoryCount(0);
            if (historyClearBtn) historyClearBtn.style.display = 'none';
            return;
        }

        historyBody.innerHTML = valid.map(r => {
            const status = STATUS_LABELS[r.status] || STATUS_LABELS.pendiente;
            const itemsHtml = (r.items || []).map(item => `
                <span>${escapeHtml(item.name)} x${item.qty} — $${item.price * item.qty}</span>
            `).join('');
            return `
                <div class="history-card" data-id="${escapeHtml(r.id)}">
                    <div class="history-card-top">
                        <span class="history-card-status ${status.className}">${status.text}</span>
                        <span class="history-card-date">${formatReservationDate(r.ts)}</span>
                    </div>
                    <div class="history-card-id">Boleto #${escapeHtml(displayShortId(r))}</div>
                    <div class="history-card-items">${itemsHtml}</div>
                    <div class="history-card-total">Total: $${r.total || 0}</div>
                </div>
            `;
        }).join('');

        updateHistoryCount(valid.length);

        detachHistoryListeners();
        valid.forEach(r => {
            const ref = reservationsRef.child(r.id);
            const handler = (snap) => {
                const val = snap.val();
                const card = historyBody.querySelector(`.history-card[data-id="${CSS.escape(r.id)}"]`);
                if (!card) return;
                if (!val) {
                    card.remove();
                    const pruned = getMyReservationIds().filter(id => id !== r.id);
                    setMyReservationIds(pruned);
                    updateHistoryCount(historyBody.querySelectorAll('.history-card').length);
                    return;
                }
                const status = STATUS_LABELS[val.status] || STATUS_LABELS.pendiente;
                const statusEl = card.querySelector('.history-card-status');
                if (statusEl) {
                    statusEl.textContent = status.text;
                    statusEl.className = `history-card-status ${status.className}`;
                }
            };
            ref.on('value', handler);
            historyListenerRefs.push({ ref, handler });
        });
    };

    const openHistory = () => {
        if (!historyOverlay) return;
        historyOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        // Al abrir el historial, el cliente "vio" el estado actual de sus
        // reservas: apagamos el puntito rojo del ícono.
        markHistoryAlert(false);
        updateNotifyBtnState();
        renderHistory();
    };

    const closeHistory = () => {
        if (!historyOverlay) return;
        historyOverlay.classList.remove('active');
        document.body.style.overflow = '';
        detachHistoryListeners();
    };

        [historyBtnMobile, historyBtnDesktop].forEach(btn => {
        if (btn) btn.addEventListener('click', openHistory);
    });
    if (historyClose) historyClose.addEventListener('click', closeHistory);
    if (historyClearBtn) {
        historyClearBtn.addEventListener('click', async () => {
            const ok = await showConfirm('Vaciar historial', 'Se eliminará todo tu historial de boletos de este dispositivo. Esta acción no se puede deshacer. ¿Continuar?');
            if (!ok) return;
            setMyReservationIds([]);
            detachHistoryListeners();
            renderHistory();
        });
    }
    if (historyOverlay) {
        historyOverlay.addEventListener('click', (e) => {
            if (e.target === historyOverlay) closeHistory();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && historyOverlay && historyOverlay.classList.contains('active')) closeHistory();
    });

    updateHistoryCount();
    updateNotifyBtnState();
    // Activa los "watchers" de todas las reservas ya guardadas de este
    // cliente para que, si el estado cambia mientras tiene el sitio
    // abierto (aunque sea en otra pestaña), reciba el aviso.
    attachGlobalReservationWatchers();
    // Si en una visita anterior quedó un cambio de estado sin ver,
    // restauramos el puntito rojo en el ícono de historial.
    if (localStorage.getItem(HISTORY_ALERT_KEY) === '1') markHistoryAlert(true);

    // ════════════════════════════════════════════
    // 🗂️ 22. PANEL DE RESERVAS CONFIRMADAS (SOLO PERSONAL AUTORIZADO)
    // ════════════════════════════════════════════
    const reservationsAdminOverlay = document.getElementById('reservationsAdminOverlay');
    const reservationsAdminClose = document.getElementById('reservationsAdminClose');
    const reservationsAdminList = document.getElementById('reservationsAdminList');
    const reservationsAdminSearch = document.getElementById('reservationsAdminSearch');
    const reservationsStatusFilter = document.getElementById('reservationsStatusFilter');
    const openReservationsAdminBtn = document.getElementById('openReservationsAdminBtn');
    const openStockFromReservationsBtn = document.getElementById('openStockFromReservationsBtn');

    let allReservations = {};
    let reservationsListenerStarted = false;

    const renderReservationsAdminList = () => {
        if (!reservationsAdminList) return;
        const query = normalizeText((reservationsAdminSearch ? reservationsAdminSearch.value : '').trim());
        const statusFilterVal = reservationsStatusFilter ? reservationsStatusFilter.value : 'all';

        let entries = Object.keys(allReservations).map(id => ({ id, ...allReservations[id] }));
        entries = entries.filter(r => {
            const status = r.status || 'pendiente';
            if (statusFilterVal !== 'all' && status !== statusFilterVal) return false;
            if (!query) return true;
            // El ID corto (shortId) entra en la búsqueda: tu equipo puede
            // escribir directamente "A4F2" (tal como lo dice el cliente
            // por WhatsApp) para encontrar la reserva al instante.
            const haystack = normalizeText(
                `${r.nombre || ''} ${r.celular || ''} ${r.shortId || ''} ${(r.items || []).map(i => i.name).join(' ')}`
            );
            return haystack.includes(query);
        });
        entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));

        if (entries.length === 0) {
            reservationsAdminList.innerHTML = '<p class="stockadmin-empty">No se encontraron reservas.</p>';
            return;
        }

        reservationsAdminList.innerHTML = entries.map(r => {
            const status = r.status || 'pendiente';
            const itemsHtml = (r.items || []).map(i => `<div>${escapeHtml(i.name)} x${i.qty} — $${i.price * i.qty}</div>`).join('');
            const fechaViajeHtml = r.fechaViaje ? `<div class="reservation-trip-date">🗓️ ${escapeHtml(formatReservationDate(new Date(r.fechaViaje).getTime()) || r.fechaViaje)}</div>` : '';
            return `
                <div class="reservation-row" data-id="${r.id}">
                    <div class="reservation-row-top">
                        <div>
                            <div class="reservation-name">${escapeHtml(r.nombre || 'Sin nombre')} <span class="reservation-shortid">#${escapeHtml(displayShortId(r))}</span></div>
                            <div class="reservation-phone">📱 ${escapeHtml(r.celular || '')}${r.pais ? ` (${escapeHtml(r.pais)})` : ''}</div>
                        </div>
                        <span class="reservation-date">${formatReservationDate(r.ts)}</span>
                    </div>
                    ${fechaViajeHtml}
                    <div class="reservation-items">${itemsHtml}</div>
                    ${r.comentarios ? `<div class="reservation-comments">💬 ${escapeHtml(r.comentarios)}</div>` : ''}
                    <div class="reservation-bottom">
                        <span class="reservation-total">Total: $${r.total || 0}</span>
                        <div class="reservation-controls">
                            <select class="reservation-status-select" data-id="${r.id}">
                                <option value="pendiente" ${status === 'pendiente' ? 'selected' : ''}>Pendiente</option>
                                <option value="confirmada" ${status === 'confirmada' ? 'selected' : ''}>Confirmada</option>
                                <option value="cancelada" ${status === 'cancelada' ? 'selected' : ''}>Cancelada</option>
                            </select>
                            <button type="button" class="reservation-delete-btn" data-id="${r.id}" aria-label="Eliminar reserva">&times;</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    };

    const startReservationsListener = () => {
        if (reservationsListenerStarted) return;
        reservationsListenerStarted = true;
        reservationsRef.on('value', (snapshot) => {
            allReservations = snapshot.val() || {};
            renderReservationsAdminList();
        }, (err) => console.error('Error al escuchar reservas:', err));
    };

    const openReservationsAdmin = () => {
        if (!reservationsAdminOverlay) return;
        startReservationsListener();
        renderReservationsAdminList();
        reservationsAdminOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    };

    const closeReservationsAdmin = () => {
        if (!reservationsAdminOverlay) return;
        reservationsAdminOverlay.classList.remove('active');
        document.body.style.overflow = '';
    };

    if (reservationsAdminClose) reservationsAdminClose.addEventListener('click', closeReservationsAdmin);
    if (reservationsAdminOverlay) {
        reservationsAdminOverlay.addEventListener('click', (e) => {
            if (e.target === reservationsAdminOverlay) closeReservationsAdmin();
        });
    }
    if (reservationsAdminSearch) reservationsAdminSearch.addEventListener('input', renderReservationsAdminList);
    if (reservationsStatusFilter) reservationsStatusFilter.addEventListener('change', renderReservationsAdminList);

    if (reservationsAdminList) {
        reservationsAdminList.addEventListener('change', (e) => {
            const select = e.target.closest('.reservation-status-select');
            if (!select) return;
            const id = select.getAttribute('data-id');
            reservationsRef.child(id).child('status').set(select.value)
                .catch(() => alert('No se pudo actualizar el estado. Revisá tu conexión.'));
        });
                reservationsAdminList.addEventListener('click', async (e) => {
            const delBtn = e.target.closest('.reservation-delete-btn');
            if (!delBtn) return;
            const id = delBtn.getAttribute('data-id');
            const ok = await showConfirm('Eliminar boleto', 'Esta acción no se puede deshacer. ¿Eliminar este boleto?');
            if (!ok) return;
            reservationsRef.child(id).remove()
                .catch(() => alert('No se pudo eliminar la reserva. Revisá tu conexión.'));
        });
    }

    if (openReservationsAdminBtn) {
        openReservationsAdminBtn.addEventListener('click', () => {
            closeStockAdmin();
            openReservationsAdmin();
        });
    }
    if (openStockFromReservationsBtn) {
        openStockFromReservationsBtn.addEventListener('click', () => {
            closeReservationsAdmin();
            openStockAdmin();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && reservationsAdminOverlay && reservationsAdminOverlay.classList.contains('active')) closeReservationsAdmin();
    });

    // ════════════════════════════════════════════
    // 🕐 19. ESTADO DE ATENCIÓN EN TIEMPO REAL (Taquilla Abierta/Cerrada)
    // ════════════════════════════════════════════
    (function initStoreStatus() {
        const statusEl = document.getElementById('storeStatus');
        const statusText = document.getElementById('storeStatusText');
        const statusHours = document.getElementById('storeStatusHours');
        if (!statusEl || !statusText || !statusHours) return;

        const OPEN_HOUR = 6;
        const CLOSE_HOUR = 21;
        const STORE_TIMEZONE = 'America/Caracas';

        let visitorTZ = STORE_TIMEZONE;
        try {
            visitorTZ = Intl.DateTimeFormat().resolvedOptions().timeZone || STORE_TIMEZONE;
        } catch (err) {
            visitorTZ = STORE_TIMEZONE;
        }

        const getTZOffsetMinutes = (date, timeZone) => {
            const dtf = new Intl.DateTimeFormat('en-US', {
                timeZone, hourCycle: 'h23',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
            const parts = {};
            dtf.formatToParts(date).forEach(p => {
                if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
            });
            const hourFixed = parts.hour === 24 ? 0 : parts.hour;
            const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, hourFixed, parts.minute, parts.second);
            return (asUTC - date.getTime()) / 60000;
        };

        const getStoreLocalParts = (date) => {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: STORE_TIMEZONE, hourCycle: 'h23',
                weekday: 'short', hour: '2-digit', minute: '2-digit'
            });
            const parts = {};
            fmt.formatToParts(date).forEach(p => {
                if (p.type !== 'literal') parts[p.type] = p.value;
            });
            const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
            let hour = parseInt(parts.hour, 10);
            if (hour === 24) hour = 0;
            return { day: dayMap[parts.weekday], hour, minute: parseInt(parts.minute, 10) };
        };

        const buildStoreTimeUTC = (referenceDate, hour, minute, dayOffset = 0) => {
            const dateFmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: STORE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
            });
            const dp = {};
            dateFmt.formatToParts(referenceDate).forEach(p => {
                if (p.type !== 'literal') dp[p.type] = parseInt(p.value, 10);
            });
            const naiveUTC = Date.UTC(dp.year, dp.month - 1, dp.day + dayOffset, hour, minute, 0);
            const offsetMin = getTZOffsetMinutes(new Date(naiveUTC), STORE_TIMEZONE);
            return new Date(naiveUTC - offsetMin * 60000);
        };

        const formatTimeOnly = (utcDate) => new Intl.DateTimeFormat('es', {
            timeZone: visitorTZ, hour: 'numeric', minute: '2-digit', hour12: true
        }).format(utcDate);

        const formatWeekday = (utcDate) => new Intl.DateTimeFormat('es', {
            timeZone: visitorTZ, weekday: 'long'
        }).format(utcDate);

        const updateStoreStatus = () => {
            try {
                const now = new Date();
                const { hour, minute } = getStoreLocalParts(now);
                const minutesNow = hour * 60 + minute;
                const estaAbierto = minutesNow >= OPEN_HOUR * 60 && minutesNow < CLOSE_HOUR * 60;

                statusEl.classList.toggle('is-open', estaAbierto);
                statusEl.classList.toggle('is-closed', !estaAbierto);

                if (estaAbierto) {
                    const closeUTC = buildStoreTimeUTC(now, CLOSE_HOUR, 0, 0);
                    statusText.textContent = 'Taquilla Abierta';
                    statusHours.textContent = `Cierra hoy a las ${formatTimeOnly(closeUTC)}`;
                } else {
                    let dayOffset = 0;
                    if (!(minutesNow < OPEN_HOUR * 60)) dayOffset = 1;
                    const openUTC = buildStoreTimeUTC(now, OPEN_HOUR, 0, dayOffset);
                    const esManana = dayOffset === 1;
                    const nombreDia = esManana ? 'mañana' : formatWeekday(openUTC);
                    statusText.textContent = 'Taquilla Cerrada';
                    statusHours.textContent = `Abre ${nombreDia} a las ${formatTimeOnly(openUTC)}`;
                }
            } catch (err) {
                statusEl.classList.remove('is-open', 'is-closed');
                statusText.textContent = 'Horario';
                statusHours.textContent = '6:00 am - 9:00 pm';
            }
        };

  updateStoreStatus();
        setInterval(updateStoreStatus, 30000);
    })();

        // AUTOCOMPLETADO DEL BUSCADOR
    (function initSearchAutocomplete() {
        const allNames = Array.from(document.querySelectorAll('.catalog-item h3'))
            .map(h3 => h3.textContent.trim());
        const uniqueNames = [...new Set(allNames)].sort((a, b) => a.localeCompare(b));

        document.querySelectorAll('[data-search-form]').forEach(form => {
            const input = form.querySelector('.nav-search-input');
            if (!input) return;

            form.style.position = 'relative';
            const dropdown = document.createElement('div');
            dropdown.className = 'search-suggestions';
            form.appendChild(dropdown);

            let activeIndex = -1;
            let currentMatches = [];

            const closeDropdown = () => {
                dropdown.classList.remove('active');
                dropdown.innerHTML = '';
                activeIndex = -1;
                currentMatches = [];
            };

            const renderDropdown = (query) => {
                const q = normalizeText(query.trim());
                if (!q) { closeDropdown(); return; }
                currentMatches = uniqueNames.filter(name => normalizeText(name).includes(q)).slice(0, 6);
                if (currentMatches.length === 0) { closeDropdown(); return; }
                dropdown.innerHTML = currentMatches.map((name, i) =>
                    `<button type="button" class="search-suggestion-item" data-index="${i}">${escapeHtml(name)}</button>`
                ).join('');
                dropdown.classList.add('active');
                activeIndex = -1;
            };

            input.addEventListener('input', () => renderDropdown(input.value));
            input.addEventListener('focus', () => { if (input.value.trim()) renderDropdown(input.value); });

            input.addEventListener('keydown', (e) => {
                if (!dropdown.classList.contains('active')) return;
                const items = dropdown.querySelectorAll('.search-suggestion-item');
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    activeIndex = Math.min(activeIndex + 1, items.length - 1);
                    items.forEach((it, i) => it.classList.toggle('active', i === activeIndex));
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    activeIndex = Math.max(activeIndex - 1, 0);
                    items.forEach((it, i) => it.classList.toggle('active', i === activeIndex));
                } else if (e.key === 'Enter' && activeIndex >= 0 && currentMatches[activeIndex]) {
                    e.preventDefault();
                    input.value = currentMatches[activeIndex];
                    closeDropdown();
                    performSearchAndScroll(input.value);
                } else if (e.key === 'Escape') {
                    closeDropdown();
                }
            });

            dropdown.addEventListener('click', (e) => {
                const item = e.target.closest('.search-suggestion-item');
                if (!item) return;
                const idx = parseInt(item.getAttribute('data-index'), 10);
                input.value = currentMatches[idx];
                closeDropdown();
                performSearchAndScroll(input.value);
            });

            document.addEventListener('click', (e) => {
                if (!form.contains(e.target)) closeDropdown();
            });
        });
    })();

    // CONFIRMACIÓN PERSONALIZADA (reemplaza confirm() nativo)
    const showConfirm = (title, text) => new Promise((resolve) => {
        const overlay = document.getElementById('confirmOverlay');
        const titleEl = document.getElementById('confirmTitle');
        const textEl = document.getElementById('confirmText');
        const okBtn = document.getElementById('confirmOkBtn');
        const cancelBtn = document.getElementById('confirmCancelBtn');
        if (!overlay) { resolve(window.confirm(text)); return; }

        titleEl.textContent = title;
        textEl.textContent = text;
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';

        const cleanup = (result) => {
            overlay.classList.remove('active');
            document.body.style.overflow = '';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            overlay.removeEventListener('click', onOverlay);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        overlay.addEventListener('click', onOverlay);
    });

});
    

    // AVISO DE ALMACENAMIENTO LOCAL (se muestra una sola vez)
    (function initStorageNotice() {
        const notice = document.getElementById('storageNotice');
        const closeBtn = document.getElementById('storageNoticeClose');
        if (!notice || !closeBtn) return;
        if (localStorage.getItem('arzotrans_storage_notice_seen')) return;
        setTimeout(() => notice.classList.add('active'), 1500);
        closeBtn.addEventListener('click', () => {
            notice.classList.remove('active');
            localStorage.setItem('arzotrans_storage_notice_seen', '1');
        });
    })();

        // MODAL DE PRIVACIDAD / TÉRMINOS
    (function initLegalModal() {
        const overlay = document.getElementById('legalOverlay');
        const closeBtn = document.getElementById('legalClose');
        const openBtns = document.querySelectorAll('[data-legal-open]');
        const tabs = document.querySelectorAll('.legal-tab');
        const panels = document.querySelectorAll('.legal-panel');
        if (!overlay) return;

        const showTab = (name) => {
            tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-legal-tab') === name));
            panels.forEach(p => p.classList.toggle('active', p.getAttribute('data-legal-panel') === name));
            overlay.querySelector('.legal-body').scrollTop = 0;
        };

        const openLegal = (name) => {
            showTab(name);
            overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        };

        const closeLegal = () => {
            overlay.classList.remove('active');
            document.body.style.overflow = '';
        };

        openBtns.forEach(btn => {
            btn.addEventListener('click', () => openLegal(btn.getAttribute('data-legal-open')));
        });
        tabs.forEach(tab => {
            tab.addEventListener('click', () => showTab(tab.getAttribute('data-legal-tab')));
        });
        if (closeBtn) closeBtn.addEventListener('click', closeLegal);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeLegal(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) closeLegal();
        });
    })();

    // ════════════════════════════════════════════
// 📸 PORTAFOLIO DE VIAJES REALIZADOS (página independiente)
// ════════════════════════════════════════════
(function initPortfolio() {
    const grid = document.getElementById('portfolioGrid');
    if (!grid) return;

    const PORTFOLIO_DATA = [
        {
            id: 'corp-banesco',
            category: 'corporativo',
            title: 'Traslado Corporativo — Conferencia Anual',
            meta: 'Caracas · Grupo empresarial',
            photos: ['https://images.unsplash.com/photo-1521737711867-e3b97375f902?w=1000&h=750&fit=crop&auto=format']
        },
        {
            id: 'corp-pdvsa',
            category: 'corporativo',
            title: 'Traslado Ejecutivo — Reunión Regional',
            meta: 'Caracas → Valencia',
            photos: [
                'https://images.unsplash.com/photo-1560472354-b33ff0c44a43?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1497215728101-856f4ea42174?w=1000&h=750&fit=crop&auto=format'
            ]
        },
        {
            id: 'corp-polar',
            category: 'corporativo',
            title: 'Convención de Ventas',
            meta: 'Maracay · Equipo comercial',
            photos: ['https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=1000&h=750&fit=crop&auto=format']
        },
        {
            id: 'edu-colegio',
            category: 'educativo-deportivo',
            title: 'Excursión Educativa — Museo de Ciencias',
            meta: 'Colegio San Ignacio · Caracas',
            photos: [
                'https://images.unsplash.com/photo-1517486808906-6ca8b3f04846?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1523050854058-8df90110c9f1?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1509062522246-3755977927d7?w=1000&h=750&fit=crop&auto=format'
            ]
        },
        {
            id: 'sport-baloncesto',
            category: 'educativo-deportivo',
            title: 'Traslado Deportivo — Torneo Regional de Baloncesto',
            meta: 'Selección juvenil · Valencia',
            photos: ['https://images.unsplash.com/photo-1546519638-68e109498ffc?w=1000&h=750&fit=crop&auto=format']
        },
        {
            id: 'edu-universidad',
            category: 'educativo-deportivo',
            title: 'Gira Educativa — Visita a Planta Industrial',
            meta: 'Universidad Central · Maracay',
            photos: [
                'https://images.unsplash.com/photo-1523240795612-9a054b0db644?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1541339907198-e08756dedf3f?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1571260899304-425eee4c7efc?w=1000&h=750&fit=crop&auto=format'
            ]
        },
        {
            id: 'tour-losroques',
            category: 'turistico',
            title: 'Grupo Turístico — Fin de Semana en Los Roques',
            meta: 'Salida desde Caracas',
            photos: [
                'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1519046904884-53103b34b206?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1500375592092-40eb2168fd21?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1544551763-77ef2d0cfc6c?w=1000&h=750&fit=crop&auto=format'
            ]
        },
        {
            id: 'tour-merida',
            category: 'turistico',
            title: 'Excursión a Mérida — Teleférico y Páramo',
            meta: 'Salida desde Valencia',
            photos: [
                'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1571687949921-1306bfb24b72?w=1000&h=750&fit=crop&auto=format',
                'https://images.unsplash.com/photo-1486870591958-9b9d0d1dda99?w=1000&h=750&fit=crop&auto=format'
            ]
        },
        {
            id: 'tour-morrocoy',
            category: 'turistico',
            title: 'Día de Playa en Morrocoy',
            meta: 'Salida desde Maracay',
            photos: ['https://images.unsplash.com/photo-1519046904884-53103b34b206?w=1000&h=750&fit=crop&auto=format']
        }
    ];

    let activeFilter = 'all';
    let lightboxPhotos = [], lightboxIndex = 0, lightboxTitle = '', lightboxMeta = '';
    let gridRendered = false;

    const escapeHtmlPf = (str) => String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));

    const categoryLabel = (cat) => ({
        'corporativo': 'Corporativo',
        'educativo-deportivo': 'Educativo / Deportivo',
        'turistico': 'Turístico'
    }[cat] || cat);

    const buildMedia = (trip) => {
        const photos = trip.photos;
        if (photos.length === 1) {
            return `
                <div class="portfolio-media single" data-trip="${trip.id}">
                    <span class="portfolio-badge">${categoryLabel(trip.category)}</span>
                    <div class="pf-photo main" data-index="0">
                        <img src="${photos[0]}" alt="${escapeHtmlPf(trip.title)}" loading="lazy">
                    </div>
                </div>`;
        }
        const thumbs = photos.slice(1, 3).map((src, i) => {
            const realIndex = i + 1;
            const isLastVisible = (realIndex === 2 && photos.length > 3);
            return `
                <div class="pf-photo" data-index="${realIndex}">
                    <img src="${src}" alt="${escapeHtmlPf(trip.title)}" loading="lazy">
                    ${isLastVisible ? `<div class="pf-photo-more">+${photos.length - 3}</div>` : ''}
                </div>`;
        }).join('');
        return `
            <div class="portfolio-media" data-trip="${trip.id}">
                <span class="portfolio-badge">${categoryLabel(trip.category)}</span>
                <span class="portfolio-photocount">📸 ${photos.length} fotos</span>
                <div class="pf-photo main" data-index="0">
                    <img src="${photos[0]}" alt="${escapeHtmlPf(trip.title)}" loading="lazy">
                </div>
                ${thumbs}
            </div>`;
    };

    const render = () => {
        const filtered = activeFilter === 'all'
            ? PORTFOLIO_DATA
            : PORTFOLIO_DATA.filter(t => t.category === activeFilter);

        if (filtered.length === 0) {
            grid.innerHTML = '<p class="portfolio-empty">Aún no hay fotos cargadas en esta categoría.</p>';
            return;
        }

        grid.innerHTML = filtered.map(trip => `
            <div class="portfolio-card">
                ${buildMedia(trip)}
                <div class="portfolio-info">
                    <h3>${escapeHtmlPf(trip.title)}</h3>
                    <div class="portfolio-meta">📍 ${escapeHtmlPf(trip.meta)}</div>
                </div>
            </div>
        `).join('');

        requestAnimationFrame(() => {
            grid.querySelectorAll('.portfolio-card').forEach((card, i) => {
                setTimeout(() => card.classList.add('visible'), i * 60);
            });
        });

        grid.querySelectorAll('.portfolio-media').forEach(mediaEl => {
            mediaEl.addEventListener('click', (e) => {
                const photoEl = e.target.closest('.pf-photo');
                const trip = PORTFOLIO_DATA.find(t => t.id === mediaEl.getAttribute('data-trip'));
                if (!trip) return;
                const startIndex = photoEl ? parseInt(photoEl.getAttribute('data-index'), 10) : 0;
                openLightbox(trip, startIndex);
            });
        });
    };

    document.querySelectorAll('#portfolioFilters .filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#portfolioFilters .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.getAttribute('data-pfilter');
            render();
        });
    });

    // ── Lightbox ──
    const lightbox = document.getElementById('portfolioLightbox');
    const lbImg = document.getElementById('pfLightboxImg');
    const lbTitle = document.getElementById('pfLightboxTitle');
    const lbSub = document.getElementById('pfLightboxSub');
    const lbCounter = document.getElementById('pfLightboxCounter');
    const lbPrev = document.getElementById('pfLightboxPrev');
    const lbNext = document.getElementById('pfLightboxNext');
    const lbClose = document.getElementById('pfLightboxClose');

    const updateLightboxView = () => {
        lbImg.src = lightboxPhotos[lightboxIndex];
        lbTitle.textContent = lightboxTitle;
        lbSub.textContent = lightboxMeta;
        lbCounter.textContent = lightboxPhotos.length > 1 ? `${lightboxIndex + 1} / ${lightboxPhotos.length}` : '';
        const multi = lightboxPhotos.length > 1;
        lbPrev.style.display = multi ? 'flex' : 'none';
        lbNext.style.display = multi ? 'flex' : 'none';
    };

    const openLightbox = (trip, startIndex) => {
        lightboxPhotos = trip.photos;
        lightboxIndex = startIndex || 0;
        lightboxTitle = trip.title;
        lightboxMeta = trip.meta;
        updateLightboxView();
        lightbox.classList.add('active');
    };

    const closeLightbox = () => lightbox.classList.remove('active');

    if (lbClose) lbClose.addEventListener('click', closeLightbox);
    if (lightbox) lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
    if (lbPrev) lbPrev.addEventListener('click', () => {
        lightboxIndex = (lightboxIndex - 1 + lightboxPhotos.length) % lightboxPhotos.length;
        updateLightboxView();
    });
    if (lbNext) lbNext.addEventListener('click', () => {
        lightboxIndex = (lightboxIndex + 1) % lightboxPhotos.length;
        updateLightboxView();
    });

    // ── Abrir/cerrar como página independiente ──
    const portfolioPage = document.getElementById('portfolioPage');
    const portfolioBackBtn = document.getElementById('portfolioBackBtn');
    const navList = document.querySelector('.nav-list');

    const openPortfolioPage = (updateHash = true) => {
        if (!gridRendered) { render(); gridRendered = true; }
        portfolioPage.classList.add('active');
        document.body.style.overflow = 'hidden';
        portfolioPage.scrollTop = 0;
        if (navList) navList.classList.remove('active');
        if (updateHash && location.hash !== '#portafolio') {
            history.pushState({ page: 'portafolio' }, '', '#portafolio');
        }
    };

    const closePortfolioPage = (updateHash = true) => {
        portfolioPage.classList.remove('active');
        closeLightbox();
        document.body.style.overflow = '';
        if (updateHash && location.hash === '#portafolio') {
            history.pushState({}, '', location.pathname + location.search);
        }
    };

    document.querySelectorAll('a[href="#portafolio"]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            openPortfolioPage();
        });
    });

    if (portfolioBackBtn) portfolioBackBtn.addEventListener('click', () => closePortfolioPage());

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && portfolioPage.classList.contains('active')) {
            if (lightbox.classList.contains('active')) closeLightbox();
            else closePortfolioPage();
        }
    });

    window.addEventListener('popstate', () => {
        if (location.hash === '#portafolio') openPortfolioPage(false);
        else closePortfolioPage(false);
    });

    // Si alguien entra directo con #portafolio en la URL
    if (location.hash === '#portafolio') openPortfolioPage(false);
})();

