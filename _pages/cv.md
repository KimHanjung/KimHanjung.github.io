---
layout: console-page
title: 'Curriculum Vitae'
index: 'CV'
permalink: /cv/
description: 'Curriculum vitae of Hanjung Kim.'
redirect_from:
  - /resume
---
{%- assign cv = site.data.profile.cv | relative_url -%}
<div class="cv-bar">
  <p class="cv-note">📝 Can be a bit outdated</p>
  <a class="btn" href="{{ cv }}" download>download pdf</a>
  <a class="btn" href="{{ cv }}" rel="noopener">open in new tab</a>
</div>
<div class="cv-frame">
  <iframe src="{{ cv }}" title="Curriculum vitae of {{ site.data.profile.name }} (PDF)"></iframe>
</div>
