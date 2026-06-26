import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GoogleLoginTest } from './google-login-test';

describe('GoogleLoginTest', () => {
  let component: GoogleLoginTest;
  let fixture: ComponentFixture<GoogleLoginTest>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GoogleLoginTest],
    }).compileComponents();

    fixture = TestBed.createComponent(GoogleLoginTest);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
