// TODO, if we add a new lang, need to update mfPkg.timestamps

// Setup in msgfmt:core on server, only used on the client in msgfmt:ui
mfPkg.mfRevisions = new Mongo.Collection('mfRevisions');

/*
 * Finds the name of the first route using the given template
 */
function routeNameFromTemplate(name) {
  var route = _.find(Router.routes, function(route) {
    if (route.options.template)
      return route.options.template == name;
    else
      return route.name == name;
  });
  return route && route.name;
}

/*
 * After user presses ctrl up-down, if the newly highlighted row
 * is not above or below the viewable area, scroll appropriately
 */
function mfCheckScroll(tr) {
  var box = $('#mfTransPreview .tbodyScroll');
  if (tr.position().top + tr.outerHeight() > box.outerHeight()) {
    box.scrollTop(box.scrollTop()+tr.outerHeight());
  } else if (tr.position().top < 0) {
    box.scrollTop(box.scrollTop()-tr.outerHeight())
  }
}

/*
 * Called whenever the user changes rows.  Checks if the text string is
 * non-empty and changed, and does the relevant database mods.  TODO,
 * consider refactoring as a Method
 */
function saveChange(lang, key, text) {
  var existing = mfPkg.mfStrings.findOne({
    lang: lang, key: key
  });
  var source = mfPkg.mfStrings.findOne({
    lang: mfPkg.native, key: key
  });

  if (!text || (existing && text == existing.text))
    return;

  var revisionId = mfPkg.mfRevisions.insert({
    lang: lang,
    key: key,
    text: text,
    ctime: new Date().getTime(),
    userId: Meteor.userId(),
    sourceId: source.revisionId
  });

  if (existing)
    mfPkg.mfStrings.update(existing._id, { $set: {
      lang: lang,
      text: text,
      mtime: new Date().getTime(),
      revisionId: revisionId
    }, $unset: { fuzzy: "" }});
  else
    mfPkg.mfStrings.insert({
      key: key,
      lang: lang,
      text: text,
      ctime: new Date().getTime(),
      mtime: new Date().getTime(),
      revisionId: revisionId
    });
}

/*
 * Called everytime the current key is changed (ctrl up/down or click)
 */
function changeKey(newKey) {
  var destLang = Session.get('mfTransTrans');
  var oldKey = Session.get('mfTransKey');
  if (oldKey == newKey) return;

  saveChange(destLang, oldKey, $('#mfTransDest').val());

  // Temporary, need to turn off preserve
  var str = mfPkg.mfStrings.findOne({
    key: newKey, lang: destLang
  });
  $('#mfTransDest').val(str ? str.text : '');

  Session.set('mfTransKey', newKey);
  $('#mfTransDest').focus();
}

if (Package['iron:router'])
Package['iron:router'].Router.map(function() {
  // Main translation page, summary of all language data
  this.route('mfTrans', {
    path: '/translate',
    waitOn: function() {
      return Meteor.subscribe('mfStats');
    },
    data: function() {
      var data = {};
      data.strings = mfPkg.mfStrings.find();
      data.stats = mfPkg.mfMeta.findOne({_id: '__stats'});
      data.native = mfPkg.native;
      return data;
    }
  });

  // Modify translations for a particular language
  this.route('mfTransLang', {
    path: '/translate/:lang',
    waitOn: function() {
      // Note, this is in ADDITION to the regular mfStrings sub
      return Meteor.subscribe('mfStrings',
        [mfPkg.native, this.params.lang], 0, true);
    },
    onBeforeAction: function() {
      if (!mfPkg.webUI.allowed.call(this) || mfPkg.webUI.denied.call(this)) {
        this.render('mfTransLangDenied');
      } else {
        // Temporary, only used to override preserve on dest
        Session.set('mfTransTrans', this.params.lang);

        // Handle ctrl-up/ctrl-down, respectively
        $(window).on('keydown.mfTrans', function(event) {
          if (event.ctrlKey && (event.which == 38 || event.which == 40)) {
            event.preventDefault(); event.stopPropagation();
            var tr = event.which == 38
              ? $('#mfTransLang tr.current').prev()
              : $('#mfTransLang tr.current').next();
            if (tr.length) {
              changeKey(tr.data('key'));
              mfCheckScroll(tr);
            }
          }
        });

        this.subscribe('mfRevisions', this.params.lang, 10);
        this.next();
      }
    },
    onStop: function() {
      $(window).off('keydown.mfTrans');
    },
    data: function() {
      var data = { strings: {} };
      var strings, out = {};
      data.orig = mfPkg.native;
      data.trans = this.params.lang;

      // summarise matching keys (orig + trans) to a single record
      strings = mfPkg.mfStrings.find({
        $and: [{$or: [{lang: data.orig}, {lang: this.params.lang}]},
          {removed: undefined}]
      }).fetch();
      _.each(strings, function(str) {
        if (!out[str.key])
          out[str.key] = { key: str.key };
        if (str.lang == data.orig)
          out[str.key].orig = str.text;
        else
          out[str.key].trans = str.text;
        if (str.fuzzy)
          out[str.key].fuzzy = true;
      });
      data.strings = _.values(out);

      return data;
    }
  });
});

Template.mfTrans.events({
  'click #mfTransNewSubmit': function() {
    Router.go('/translate/' + $('#mfTransNewText').val());
  },
  'click #mfAllJs': function(event, tpl) {
    // Make sure we have no conflicts with iron-router
    // Not really sure why this is necessary; TODO, investigate
    event.preventDefault();
    event.stopPropagation();
    window.location = '/translate/mfAll.js';
  }
});

Template.mfTransLang.events({
  'click #mfTransLang tr': function(event) {
    var tr = $(event.target).parents('tr');
    var key = tr.data('key');
    if (key) changeKey(key);
  }
});

Template.mfTransLang.helpers({
  stateClass: function() {
    if (this.fuzzy)
      return 'fuzzy';
    if (this.trans)
      return 'trans';
    else
      return 'untrans';
  },
  isCurrent: function() {
    if (this.key == Session.get('mfTransKey'))
      return 'current';
  },
  mfTransOrig: function() {
    var str = mfPkg.mfStrings.findOne({
      key: Session.get('mfTransKey'),
      lang: this.orig
    });
    return str ? str.text : '';
  },
  mfTransTrans: function() {
    var str = mfPkg.mfStrings.findOne({
      key: Session.get('mfTransKey'),
      lang: this.trans
    });
    return str ? str.text : '';
  },
  keyInfo: function() {
    var str = mfPkg.mfStrings.findOne({
      key: Session.get('mfTransKey'),
      lang: this.orig
    });
    if (str && str.template) {
      var routeName = routeNameFromTemplate(str.template);
      if (routeName)
        str.routeUrl = Router.path(routeName);
    }
    return str || {};
  }
});

var initialRender = _.once(function() {
  var key = Session.get('mfTransKey'),
    tr = $('#mfTransLang tr[data-key="'+key+'"]');
  if (tr.length)
    $('#mfTransPreview .tbodyScroll').scrollTop(tr.position().top);

  $('#mfTransDest').focus();
});

Template.mfTransLang.rendered = function() {
  var tr, key = Session.get('mfTransKey');

  // For unset or nonexistent key, set to first row
  if (!key || !$('tr[data-key="' + key + '"]').length) {
    key = $('#mfTransLang tr[data-key]:first-child').data('key');
    Session.set('mfTransKey', key);
  }

  var transDest = $('#mfTransDest');
  if (typeof transDest.tabOverride === 'function') transDest.tabOverride();
  initialRender();
};