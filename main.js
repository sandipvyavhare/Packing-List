// --- STORAGE KEYS & GLOBAL STATE ---
const STORAGE_PRODUCTS = 'packing_products_v4';
const STORAGE_PACKING_LISTS = 'packing_lists_v4';
const STORAGE_PL_SEQ = 'pl_seq_v4_';

let products = JSON.parse(localStorage.getItem(STORAGE_PRODUCTS) || '[]');
let packingLists = JSON.parse(localStorage.getItem(STORAGE_PACKING_LISTS) || '[]');
let editingProductId = null;
let batchCache = [];

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('companyRefresh').addEventListener('click', () => window.location.reload());
    document.getElementById('addBatchBtn').addEventListener('click', addBatchRow);
    document.getElementById('batchTable').addEventListener('input', handleBatchTableInput);
    document.getElementById('batchTable').addEventListener('click', handleBatchTableClick);
    document.getElementById('productBatchForm').addEventListener('submit', handleProductFormSubmit);
    document.getElementById('cancelEditBtn').addEventListener('click', resetProductForm);
    document.getElementById('dbSearchBtn').addEventListener('click', () => renderProducts(document.getElementById('dbSearchInput').value.trim()));
    document.getElementById('plSearchBtn').addEventListener('click', () => renderPackingLists(document.getElementById('plSearchInput').value.trim()));
    document.getElementById('dbSearchInput').addEventListener('keydown', e => e.key === 'Enter' && (e.preventDefault(), document.getElementById('plSearchBtn').click()));
    document.getElementById('plSearchInput').addEventListener('keydown', e => e.key === 'Enter' && (e.preventDefault(), document.getElementById('plSearchBtn').click()));
    document.getElementById('plProductSelect').addEventListener('change', e => showAvailableBatches(e.target.value));
    document.getElementById('generatePLForm').addEventListener('submit', e => (e.preventDefault(), generatePackingList()));
    document.querySelector('.close-btn').addEventListener('click', () => document.getElementById('previewModal').style.display = 'none');
    window.addEventListener('click', e => e.target === document.getElementById('previewModal') && (document.getElementById('previewModal').style.display = 'none'));
    document.getElementById('savePdfBtn').addEventListener('click', savePreviewAsPdf);
    resetProductForm();
    renderProducts();
    renderPackingLists();
    populateProductSelect();
});

// --- EVENT HANDLERS ---
function addBatchRow() {
    batchCache.push({ batchNo: '', boxFrom: '', boxTo: '' });
    renderBatchTable();
}

function handleBatchTableInput(e) {
    const idx = e.target.dataset.idx;
    if (idx === undefined) return;
    if (e.target.classList.contains('batchNoIn')) batchCache[idx].batchNo = e.target.value.trim();
    else if (e.target.classList.contains('boxFromIn')) batchCache[idx].boxFrom = e.target.value;
    else if (e.target.classList.contains('boxToIn')) batchCache[idx].boxTo = e.target.value;
}

function handleBatchTableClick(e) {
    if (e.target.classList.contains('remBatchBtn')) {
        const idx = e.target.dataset.idx;
        batchCache.splice(idx, 1);
        renderBatchTable();
    }
}

function handleProductFormSubmit(e) {
    e.preventDefault();
    saveProduct();
}

// --- CORE LOGIC FUNCTIONS ---
function resetProductForm() {
    editingProductId = null;
    batchCache = [];
    renderBatchTable();
    document.getElementById('productBatchForm').reset();
    document.getElementById('cancelEditBtn').style.display = 'none';
    document.getElementById('saveProductBtn').textContent = 'Save Product & Batches';
}

function saveProduct() {
    const productData = {
        id: editingProductId || Date.now().toString(),
        name: document.getElementById('productName').value.trim(),
        mfgDate: document.getElementById('mfgDate').value,
        expDate: document.getElementById('expDate').value,
        quantityPerBox: document.getElementById('quantityPerBox').value.trim(),
        grossWeight: document.getElementById('grossWeight').value,
        netWeight: document.getElementById('netWeight').value,
        shippingMarks: document.getElementById('shippingMarks').value,
        shipperSize: document.getElementById('shipperSize').value,
    };

    if (!productData.name || !productData.mfgDate || !productData.expDate || !productData.quantityPerBox || !productData.grossWeight || !productData.netWeight) {
        return alert('Please fill all required product fields.');
    }
    if (batchCache.length === 0) {
        return alert('Please add at least one batch.');
    }

    const batchNos = new Set();
    for (const batch of batchCache) {
        if (!batch.batchNo || !batch.boxFrom || !batch.boxTo || Number(batch.boxFrom) > Number(batch.boxTo)) {
            return alert('All batches must have a valid Batch No and Box Range (From <= To).');
        }
        const lowerBatchNo = batch.batchNo.toLowerCase();
        if (batchNos.has(lowerBatchNo) || isBatchDuplicate(batch.batchNo, productData.id)) {
            return alert(`Error: Batch number "${batch.batchNo}" is a duplicate.`);
        }
        batchNos.add(lowerBatchNo);
    }

    productData.batches = JSON.parse(JSON.stringify(batchCache));
    const existingIndex = products.findIndex(p => p.id === productData.id);
    if (existingIndex > -1) products[existingIndex] = productData;
    else products.push(productData);

    saveAllData();
    resetProductForm();
    renderProducts();
    populateProductSelect();
}

function generatePackingList() {
    const productId = document.getElementById('plProductSelect').value;
    const plDate = document.getElementById('plDate').value;
    if (!productId) return alert('Please select a product.');
    if (!plDate) return alert('Please select a packing list date.');

    const product = products.find(p => p.id === productId);
    if (!product) return alert('Product not found.');

    const selectedBatches = [];
    document.querySelectorAll('#availableBatchesWrap .batchCheckbox:checked').forEach(cb => {
        const batchNo = cb.dataset.batch;
        const qtyInput = document.querySelector(`#availableBatchesWrap .batchQty[data-batch="${batchNo}"]`);
        const qty = parseInt(qtyInput.value, 10);
        if (qty > 0) selectedBatches.push({ batchNo, qty });
    });

    if (selectedBatches.length === 0) return alert('Please select at least one batch to dispatch.');

    const plBatches = [];
    for (const { batchNo, qty } of selectedBatches) {
        const batch = product.batches.find(b => b.batchNo === batchNo);
        const availRanges = getAvailableRanges(batch);
        const pickRanges = [];
        let required = qty;

        for (const range of availRanges) {
            if (required <= 0) break;
            const availableInRange = range.to - range.from + 1;
            const toPick = Math.min(required, availableInRange);
            pickRanges.push({ from: range.from, to: range.from + toPick - 1 });
            required -= toPick;
        }

        if (required > 0) return alert(`Not enough available boxes in batch ${batchNo}.`);
        plBatches.push({ batch, pickRanges });
    }

    const plNo = generateNextPLNumber();
    plBatches.forEach(({ batch, pickRanges }) => {
        batch.dispatched = batch.dispatched || [];
        pickRanges.forEach(range => batch.dispatched.push({ ...range, plNo }));
    });

    packingLists.push({
        plNo,
        productId,
        date: plDate,
        batches: plBatches.map(({ batch, pickRanges }) => ({
            batchNo: batch.batchNo,
            dispatchedSegments: pickRanges
        }))
    });

    saveAllData();
    renderProducts();
    renderPackingLists(plNo);
    populateProductSelect();
    showAvailableBatches(productId);
    showPreview(product, plBatches, plNo);
}

// --- RENDER FUNCTIONS ---
function renderBatchTable() {
    const tbody = document.querySelector('#batchTable tbody');
    tbody.innerHTML = batchCache.map((batch, idx) => `
        <tr>
            <td><input data-idx="${idx}" class="batchNoIn" type="text" value="${batch.batchNo || ''}" required></td>
            <td><input data-idx="${idx}" class="boxFromIn" type="number" min="1" value="${batch.boxFrom || ''}" required></td>
            <td><input data-idx="${idx}" class="boxToIn" type="number" min="1" value="${batch.boxTo || ''}" required></td>
            <td><button type="button" data-idx="${idx}" class="remBatchBtn">✕</button></td>
        </tr>
    `).join('');
}

function renderProducts(filter = '') {
    const container = document.getElementById('databaseList');
    if (!filter) {
        container.innerHTML = '<em>Type a product name or batch number to search.</em>';
        return;
    }
    const isBatchSearch = /[a-z]/i.test(filter) && /[0-9]/.test(filter);
    let results = [];
    if (isBatchSearch) {
        products.forEach(p => {
            const matchedBatches = p.batches.filter(b => b.batchNo.toLowerCase().includes(filter.toLowerCase()));
            if (matchedBatches.length > 0) results.push({ product: p, batches: matchedBatches });
        });
    } else {
        results = products
            .filter(p => p.name.toLowerCase().includes(filter.toLowerCase()))
            .map(p => ({ product: p, batches: p.batches.filter(b => !isBatchFullyDispatched(b)) }))
            .filter(r => r.batches.length > 0);
    }
    container.innerHTML = results.length === 0 ? '<em>No results found.</em>' : results.map(({ product, batches }) => `
        <div class="db-group">
            <div class="db-group-header" onclick="toggleElement('pgb_${product.id}')">
                <span>${product.name} [${batches.length} batch${batches.length !== 1 ? 'es' : ''}]</span>
                <span>
                    <a href="#" onclick="event.stopPropagation(); editProduct('${product.id}')">Edit</a> | 
                    <a href="#" onclick="event.stopPropagation(); deleteProduct('${product.id}')">Delete</a>
                </span>
            </div>
            <div id="pgb_${product.id}" class="db-group-content">
                ${batches.map(b => `<div class="db-batch-row ${isBatchFullyDispatched(b) ? 'locked' : ''}">
                    <span><b>Batch:</b> ${b.batchNo} (${b.boxFrom}-${b.boxTo})</span>
                    <span><b>Dispatched:</b> ${getDispatchedCount(b)} / ${getTotalBoxes(b)}</span>
                </div>`).join('')}
            </div>
        </div>
    `).join('');
}

function renderPackingLists(filter = '') {
    const container = document.getElementById('packingListResults');
    if (!filter) {
        container.innerHTML = '<em>Type a packing list number to search.</em>';
        return;
    }
    const results = packingLists.filter(pl => pl.plNo.toLowerCase().includes(filter.toLowerCase()));
    container.innerHTML = results.length === 0 ? '<em>No packing lists found.</em>' : results.map(pl => {
        const product = products.find(p => p.id === pl.productId);
        return `
        <div class="packing-list-row">
            <div><b>${pl.plNo}</b> - ${product ? product.name : '(Unknown Product)'}</div>
            <div>
                <button class="btn btn-secondary btn-sm" onclick="editPackingList('${pl.plNo}')">Edit</button>
                <button class="btn btn-primary btn-sm" onclick="previewPackingList('${pl.plNo}')">Preview</button>
                <button class="btn btn-primary btn-sm" onclick="savePackingListAsPdf('${pl.plNo}')">Save PDF</button>
                <button class="btn btn-danger btn-sm" onclick="deletePackingList('${pl.plNo}')">Delete</button>
            </div>
        </div>`;
    }).join('');
}

function populateProductSelect() {
    const select = document.getElementById('plProductSelect');
    select.innerHTML = '<option value="">-- Select a Product --</option>';
    products.forEach(p => {
        if (p.batches.some(b => !isBatchFullyDispatched(b))) {
            select.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        }
    });
}

function showAvailableBatches(productId) {
    const container = document.getElementById('availableBatchesWrap');
    container.innerHTML = '';
    if (!productId) return;
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const availableBatches = product.batches.filter(b => !isBatchFullyDispatched(b));
    if (availableBatches.length === 0) {
        container.innerHTML = '<p>No available batches for this product.</p>';
        return;
    }
    const rows = availableBatches.map(batch => {
        const availRanges = getAvailableRanges(batch).map(r => `${r.from}-${r.to}`).join(', ');
        const availQty = getAvailableRanges(batch).reduce((acc, r) => acc + (r.to - r.from + 1), 0);
        return `
            <tr>
                <td><input type="checkbox" class="batchCheckbox" data-batch="${batch.batchNo}"></td>
                <td>${batch.batchNo}</td>
                <td>${availRanges}</td>
                <td><input type="number" min="1" max="${availQty}" value="${availQty}" disabled class="batchQty" data-batch="${batch.batchNo}"><span style="font-size:0.9rem; color:#555;"> (max ${availQty})</span></td>
            </tr>`;
    }).join('');

    container.innerHTML = `
        <table class="available-batches-table">
            <thead><tr><th>Select</th><th>Batch No.</th><th>Available Boxes</th><th>Qty to Dispatch</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;

    container.querySelectorAll('.batchCheckbox').forEach(cb => {
        cb.addEventListener('change', e => {
            const batchNo = e.target.dataset.batch;
            const qtyInput = container.querySelector(`.batchQty[data-batch="${batchNo}"]`);
            if (qtyInput) qtyInput.disabled = !e.target.checked;
        });
    });
}

function showPreview(product, plBatches, plNo) {
    console.log('showPreview called with:', { productId: product.id, plNo, batchCount: plBatches.length });
    const previewContainer = document.getElementById('packingListPreview');
    let plDate;
    const existingPL = packingLists.find(pl => pl.plNo === plNo);
    if (existingPL) {
        plDate = existingPL.date;
    } else {
        plDate = document.getElementById('plDate').value;
    }
    let totalDispatchedBoxes = 0;
    let totalGrossWeight = 0;
    let totalNetWeight = 0;
    const tableRows = plBatches.map(({ batch, pickRanges }) =>
        pickRanges.map(range => {
            const boxesInSegment = Number(range.to) - Number(range.from) + 1;
            totalDispatchedBoxes += boxesInSegment;
            totalGrossWeight += product.grossWeight * boxesInSegment;
            totalNetWeight += product.netWeight * boxesInSegment;
            return `
                <tr>
                    <td>${range.from} - ${range.to}</td>
                    <td>${boxesInSegment}</td>
                    <td>${batch.batchNo}</td>
                    <td>${formatMMMYYYY(product.mfgDate)}</td>
                    <td>${formatMMMYYYY(product.expDate)}</td>
                    <td>${product.quantityPerBox}</td>
                    <td>${Number(product.grossWeight).toFixed(3)}</td>
                    <td>${Number(product.netWeight).toFixed(3)}</td>
                </tr>`;
        }).join('')
    ).join('');

    previewContainer.innerHTML = `
        <div class="pl-header">
            <h2>QUALITY MEDIGEN PHARMACEUTICALS</h2>
            <h3>PACKING LIST</h3>
        </div>
        <div class="pl-top-section">
            <div class="pl-details-left">
                <b>Date:</b><span>${plDate ? new Date(plDate).toLocaleDateString('en-GB') : 'N/A'}</span>
                <b>Name of Product:</b><span>${product.name}</span>
                <b>Total Boxes:</b><span>${totalDispatchedBoxes} Boxes</span>
                <b>Total Gross Wt.:</b><span>${totalGrossWeight.toFixed(2)} Kg</span>
                <b>Total Net Wt.:</b><span>${totalNetWeight.toFixed(2)} Kg</span>
                <b>Shipping Marks:</b><span>${product.shippingMarks || ''}</span>
            </div>
            <div class="pl-details-right">
                <b>Shipper Size:</b><span>${product.shipperSize || ''}</span>
            </div>
        </div>
        <table class="pl-main-table">
            <thead><tr><th>Box No.</th><th>Total Boxes</th><th>Batch No.</th><th>Mfg. Date</th><th>Exp. Date</th><th>Qty/Box</th><th>Gr.Wt/Box</th><th>Net Wt/Box</th></tr></thead>
            <tbody>
                ${tableRows}
                <tr class="total-row">
                    <td>Total</td>
                    <td>${totalDispatchedBoxes}</td>
                    <td colspan="3">Master Cartons</td>
                    <td></td>
                    <td>${totalGrossWeight.toFixed(2)}</td>
                    <td>${totalNetWeight.toFixed(2)}</td>
                </tr>
            </tbody>
        </table>
        <div class="pl-signature-section">
            <div>FOR</div>
            <div>QUALITY MEDIGEN PHARMACEUTICALS</div>
            <p>Authorized Signatory</p>
        </div>
        <div style="clear:both;"></div>
    `;
    console.log('Preview content rendered:', previewContainer.innerHTML.substring(0, 200) + '...'); // Truncated for brevity
    document.getElementById('previewModal').style.display = 'block';
    previewContainer.dataset.plNo = plNo;
    console.log('Preview modal opened, plNo:', plNo);
}

// --- PDF Export: Fit to A4, Calibri 11pt, No Left Cut ---
async function savePreviewAsPdf() {
    const element = document.getElementById('packingListPreview');
    const modal = document.getElementById('previewModal');
    console.log('savePreviewAsPdf called, checking modal and content...');
    if (!modal || modal.style.display !== 'block' || !element || !element.innerHTML.trim()) {
        console.error('Preview modal or content not found:', { modalDisplay: modal?.style.display, contentLength: element?.innerHTML.length });
        return alert('Preview modal or content not found. Ensure the preview is open and loaded.');
    }
    const computedStyles = getComputedStyle(element);
    if (computedStyles.visibility === 'hidden' || computedStyles.opacity === '0' || computedStyles.display === 'none') {
        console.error('Preview element is not visible:', { visibility: computedStyles.visibility, opacity: computedStyles.opacity, display: computedStyles.display });
        return alert('Preview content is not visible. Ensure it is fully rendered.');
    }
    const plNo = element.dataset.plNo || 'PackingList';
    const sanitizedPlNo = plNo.replace(/[/\\]/g, '_');

    // Ensure DOM is fully rendered
    console.log('Waiting for DOM rendering, scrollHeight:', element.scrollHeight, 'offsetHeight:', element.offsetHeight);
    await new Promise(resolve => setTimeout(resolve, 5000)); // Increased to 5 seconds
    await new Promise(resolve => requestAnimationFrame(resolve));

    // Temporarily set styles and ensure visibility
    const originalStyles = {
        width: element.style.width,
        padding: element.style.padding,
        margin: element.style.margin,
        display: element.style.display,
        position: element.style.position,
        visibility: element.style.visibility,
        opacity: element.style.opacity
    };
    element.style.width = '8.27in';
    element.style.padding = '0';
    element.style.margin = '0';
    element.style.boxSizing = 'border-box';
    element.style.display = 'block';
    element.style.position = 'relative';
    element.style.visibility = 'visible';
    element.style.opacity = '1';
    modal.style.display = 'block';

    // Check if html2pdf is available
    if (typeof html2pdf === 'undefined') {
        console.error('html2pdf.js is not loaded. Check script inclusion or network restrictions.');
        return alert('PDF generation failed: html2pdf.js library not found. A 403 error suggests the script is blocked. Please add it manually or adjust your CSP/network settings.');
    }

    const options = {
        margin: 0.3,
        filename: `PackingList_${sanitizedPlNo}.pdf`,
        image: { type: 'jpeg', quality: 0.9 },
        html2canvas: {
            scale: 2, // Increased scale for better quality
            useCORS: true,
            logging: true
        },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait', putOnlyUsedFonts: true }
    };

    try {
        console.log('Generating PDF with options:', options);
        const pdf = await html2pdf().set(options).from(element).toPdf();
        await pdf.save();
        console.log('PDF generated successfully for plNo:', plNo);
    } catch (error) {
        console.error('PDF generation failed:', error.message, error.stack, 'Element HTML:', element.outerHTML.substring(0, 200) + '...');
        alert('Failed to generate PDF. Check the console for details. Ensure the preview is fully loaded and visible.');
    } finally {
        Object.assign(element.style, originalStyles);
        modal.style.display = originalStyles.display || 'block';
        console.log('Restored original styles, modal display:', modal.style.display);
    }
}

// --- GLOBAL HELPER FUNCTIONS (callable from onclick) ---
window.editProduct = (productId) => {
    const product = products.find(p => p.id === productId);
    if (!product) return;
    editingProductId = productId;
    document.getElementById('productName').value = product.name;
    document.getElementById('mfgDate').value = product.mfgDate;
    document.getElementById('expDate').value = product.expDate;
    document.getElementById('quantityPerBox').value = product.quantityPerBox;
    document.getElementById('grossWeight').value = product.grossWeight;
    document.getElementById('netWeight').value = product.netWeight;
    document.getElementById('shippingMarks').value = product.shippingMarks;
    document.getElementById('shipperSize').value = product.shipperSize;
    batchCache = JSON.parse(JSON.stringify(product.batches));
    renderBatchTable();
    document.getElementById('saveProductBtn').textContent = 'Update Product';
    document.getElementById('cancelEditBtn').style.display = 'inline-block';
    document.getElementById('add-edit-section').scrollIntoView({ behavior: 'smooth' });
};

window.deleteProduct = (productId) => {
    if (confirm('Are you sure you want to delete this product and all its batches? This cannot be undone.')) {
        products = products.filter(p => p.id !== productId);
        packingLists = packingLists.filter(pl => pl.productId !== productId);
        saveAllData();
        renderProducts(document.getElementById('dbSearchInput').value.trim());
        populateProductSelect();
    }
};

window.editPackingList = (plNo) => alert('Editing existing packing lists is not yet implemented.');

window.previewPackingList = (plNo) => {
    console.log('previewPackingList called with plNo:', plNo);
    const pl = packingLists.find(p => p.plNo === plNo);
    if (!pl) {
        console.error('Packing list not found for plNo:', plNo);
        return alert('Packing list not found.');
    }
    const product = products.find(p => p.id === pl.productId);
    if (!product) {
        console.error('Associated product not found for productId:', pl.productId);
        return alert('Associated product not found.');
    }
    const plBatches = pl.batches.map(b => ({
        batch: product.batches.find(pb => pb.batchNo === b.batchNo),
        pickRanges: b.dispatchedSegments
    }));
    document.getElementById('packingListPreview').dataset.plNo = pl.plNo;
    showPreview(product, plBatches, pl.plNo);
};

window.savePackingListAsPdf = async (plNo) => {
    console.log('savePackingListAsPdf called with plNo:', plNo);
    window.previewPackingList(plNo);
    // Wait for preview to render
    await new Promise(resolve => setTimeout(resolve, 1000));
    await savePreviewAsPdf();
};

window.deletePackingList = (plNo) => {
    if (confirm(`Are you sure you want to delete Packing List ${plNo}? This will make its dispatched boxes available again.`)) {
        products.forEach(p => {
            p.batches.forEach(b => {
                b.dispatched = (b.dispatched || []).filter(d => d.plNo !== plNo);
            });
        });
        packingLists = packingLists.filter(pl => pl.plNo !== plNo);
        saveAllData();
        renderPackingLists(document.getElementById('plSearchInput').value.trim());
        populateProductSelect();
    }
};

window.toggleElement = (id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

// --- UTILITY FUNCTIONS ---
function saveAllData() {
    localStorage.setItem(STORAGE_PRODUCTS, JSON.stringify(products));
    localStorage.setItem(STORAGE_PACKING_LISTS, JSON.stringify(packingLists));
}

function generateFinancialYear() {
    const d = new Date();
    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    return month >= 4 ? `${String(year).slice(-2)}-${String(year + 1).slice(-2)}` : `${String(year - 1).slice(-2)}-${String(year).slice(-2)}`;
}

function generateNextPLNumber() {
    const finYear = generateFinancialYear();
    const key = `${STORAGE_PL_SEQ}${finYear}`;
    const nextSeq = (parseInt(localStorage.getItem(key) || '0', 10)) + 1;
    localStorage.setItem(key, nextSeq);
    return `QMP/PL/${finYear}/${String(nextSeq).padStart(3, '0')}`;
}

function isBatchDuplicate(batchNo, excludeProductId) {
    return products.some(p => p.id !== excludeProductId && p.batches.some(b => b.batchNo.toLowerCase() === batchNo.toLowerCase()));
}

function getDispatchedCount(batch) {
    return (batch.dispatched || []).reduce((acc, d) => acc + (Number(d.to) - Number(d.from) + 1), 0);
}

function getTotalBoxes(batch) {
    return Number(batch.boxTo) - Number(batch.boxFrom) + 1;
}

function isBatchFullyDispatched(batch) {
    return getDispatchedCount(batch) >= getTotalBoxes(batch);
}

function getAvailableRanges(batch) {
    const dispatchedBoxes = new Set();
    (batch.dispatched || []).forEach(d => {
        for (let i = Number(d.from); i <= Number(d.to); i++) dispatchedBoxes.add(i);
    });
    const ranges = [];
    let start = null;
    for (let i = Number(batch.boxFrom); i <= Number(batch.boxTo); i++) {
        if (!dispatchedBoxes.has(i)) {
            if (start === null) start = i;
        } else {
            if (start !== null) {
                ranges.push({ from: start, to: i - 1 });
                start = null;
            }
        }
    }
    if (start !== null) ranges.push({ from: start, to: Number(batch.boxTo) });
    return ranges;
}

function formatMMMYYYY(dateString) {
    if (!dateString) return '';
    const [year, month] = dateString.split('-');
    const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'short' });
    return `${monthName}-${year}`;
}