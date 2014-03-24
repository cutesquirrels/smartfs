
var dom = {}, currentEntry = null;

window.addEventListener('load', function() {
  dom.list = document.getElementById('list');
  dom.content = document.getElementById('content');

  setInterval(updateNews, 20 * 60 * 1000);
  loadNews();
});

function updateNews() {
  runAction("update", loadNews);
}

function loadNews() {
  setLoading(dom.list);
  runAction("load-unread", renderNews);
}

function setLoading(domElement) {
  domElement.textContent = "Loading...";
}

function setCurrent(entry) {
  var current = dom.list.getElementsByClassName('current');
  for(var i=0;i<current.length;i++) {
    current[i].classList.remove('current');
  }
  currentEntry = entry;
  dom.list.querySelector('*[data-id="' + entry._id + '"]').classList.add('current');
}

function renderNews(entries) {
  renderList(entries);
  if(! currentEntry) {
    setCurrent(entries[0]);
    renderContent();
  }
}

function renderContent() {
  if(currentEntry) {
    dom.content.innerHTML = "";
    var source = document.createElement('div');
    var key = document.createElement('strong');
    key.textContent = "Source: ";
    var value = document.createElement('a');
    value.textContent = currentEntry.feed.name;
    value.href = currentEntry.feed.link;
    source.appendChild(key);
    source.appendChild(value);
    dom.content.appendChild(source);
    var p = document.createElement('p');
    p.innerHTML = currentEntry.contentHTML;
    dom.content.appendChild(p);
  } else {
    dom.content.textContent = "No current entry.";
  }
}

function renderList(entries) {
  dom.list.innerHTML = '';
  entries.forEach(function(entry) {
    dom.list.appendChild(renderEntry(entry));
  });
}

function renderEntry(entry) {
  var li = document.createElement('li');
  li.dataset.id = entry._id;
  li.textContent = "(" + entry.feed.name + ") " + entry.title;
  li.addEventListener('click', function() {
    setCurrent(entry);
    renderContent();
  });
  return li;
}

function runAction(action, callback) {
  var args = Array.prototype.slice.call(arguments, 2);
  var path = [action].concat(args).join('/');
  var req = new XMLHttpRequest();
  req.open('POST', 'http://localhost:7845/' + path);
  req.addEventListener('load', function() {
    if(req.responseStatus === 500) {
      throw new Error("Failed to run action " + action + ": " + req.responseText);
    } else {
      var stack = JSON.parse(req.responseText);
      callback.apply(this, stack);
    }
  });
  req.send();
}
