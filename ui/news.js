
var dom = {}, currentEntry = null, actions = {}, newsLoadAction;

window.addEventListener('load', function() {
  dom.list = document.getElementById('list');
  dom.content = document.getElementById('content');
  dom.controls = document.getElementById('controls');
  dom.list.nav = document.getElementById('list-nav');

  dom.list.nav.addEventListener('click', function(event) {
    if(event.target.tagName === 'A' && event.target.dataset.action) {
      setNewsLoadAction(event.target.dataset.action);
      loadNews();
    }
  });

  dom.controls.addEventListener('click', function(event) {
    if(event.target.tagName === 'BUTTON') {
      var action = event.target.dataset.action;
      actions[action]();
    }
  });

  setNewsLoadAction("load-unread");

  setInterval(updateNews, 20 * 60 * 1000);
  loadNews();
});

function setNewsLoadAction(action) {
  newsLoadAction = action;
  var current = dom.list.nav.getElementsByClassName('current');
  for(var i=0;i<current.length;i++) {
    current[i].classList.remove('current');
  }
  dom.list.nav.querySelector('*[data-action="' + action + '"]').classList.add('current');
}

actions['flag-read'] = function() {
  if(currentEntry) {
    runAction('flag-read', function() {
      var currentRow = getListItem(currentEntry._id);
      currentRow.nextElementSibling.click();
      currentRow.parentNode.removeChild(currentRow);
    }, currentEntry._id);
  }
};

function updateNews() {
  runAction("update", loadNews);
}

function loadNews() {
  setLoading(dom.list);
  runAction(newsLoadAction, renderNews);
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
  getListItem(entry._id).classList.add('current');
}

function getListItem(id) {
  var result = dom.list.querySelector('*[data-id="' + id + '"]');
  console.log('get item', id, '->', result);
  return result;
}

function renderNews(entries) {
  renderList(entries);
  if((! currentEntry) && entries.length > 0) {
    setCurrent(entries[0]);
    renderContent();
  } else {
    // doesn't re-render content, but highlights item in list.
    setCurrent(currentEntry);
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
  if(entries.length === 0) {
    dom.list.textContent = "No entries.";
  } else {
    entries.forEach(function(entry) {
      dom.list.appendChild(renderEntry(entry));
    });
  }
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
