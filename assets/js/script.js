'use strict';

const sidebar = document.querySelector('[data-sidebar]');
const sidebarBtn = document.querySelector('[data-sidebar-btn]');
const navigationLinks = document.querySelectorAll('[data-nav-link]');
const pages = document.querySelectorAll('[data-page]');

if (sidebar && sidebarBtn) {
  sidebarBtn.addEventListener('click', () => {
    sidebar.classList.toggle('active');
  });
}

navigationLinks.forEach((link) => {
  link.addEventListener('click', () => {
    const targetPage = link.textContent.trim().toLowerCase();

    pages.forEach((page) => {
      page.classList.toggle('active', page.dataset.page === targetPage);
    });

    navigationLinks.forEach((navLink) => {
      navLink.classList.toggle('active', navLink === link);
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});
